//! RemoteDiscovery — connects to a remote Discovery Server via TCP.
//!
//! Implements the `Discovery` trait by sending `DiscoveryMessage` frames
//! over TCP to the discovery-server at `127.0.0.1:9000`.
//!
//! Wire format: [4-byte BE length][JSON body]

use crate::discovery::{Discovery, DiscoveryError};
use crate::protocol::*;
use async_trait::async_trait;
use bytes::{BufMut, BytesMut};
use serde_json;
use std::collections::HashMap;
use std::io;
use std::sync::Mutex;
use tokio::net::TcpStream;
use tracing::debug;

/// Remote Discovery client that connects to a Discovery Server via TCP.
pub struct RemoteDiscovery {
    addr: String,
    /// Cache of known agents for local `get_agent` / `list_agents` queries.
    /// Populated from register/query responses.
    agent_cache: Mutex<HashMap<DID, AgentProfile>>,
}

impl RemoteDiscovery {
    pub fn new(addr: &str) -> Self {
        Self {
            addr: addr.to_string(),
            agent_cache: Mutex::new(HashMap::new()),
        }
    }

    /// Connect to the discovery server and send/receive one message.
    async fn send_message(&self, msg: &DiscoveryMessage) -> io::Result<DiscoveryMessage> {
        let stream = TcpStream::connect(&self.addr).await?;
        debug!("Connected to discovery server at {}", self.addr);

        let (reader, writer) = stream.into_split();
        let mut reader = tokio::io::BufReader::new(reader);
        let mut writer = tokio::io::BufWriter::new(writer);

        // Encode: [4-byte BE length][JSON]
        let json = serde_json::to_vec(msg)?;
        let len = json.len() as u32;
        let mut buf = BytesMut::with_capacity(4 + json.len());
        buf.put_u32(len);
        buf.extend_from_slice(&json);

        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        writer.write_all(&buf).await?;
        writer.flush().await?;

        // Read response: [4-byte BE length][JSON]
        let mut len_buf = [0u8; 4];
        reader.read_exact(&mut len_buf).await?;
        let resp_len = u32::from_be_bytes(len_buf) as usize;

        if resp_len > 10 * 1024 * 1024 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("Response too large: {} bytes", resp_len),
            ));
        }

        let mut resp_buf = vec![0u8; resp_len];
        reader.read_exact(&mut resp_buf).await?;

        let resp: DiscoveryMessage = serde_json::from_slice(&resp_buf).map_err(|e| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!("JSON parse error: {}", e),
            )
        })?;

        Ok(resp)
    }
}

#[async_trait]
impl Discovery for RemoteDiscovery {
    async fn register(&self, profile: AgentProfile) -> Result<Lease, DiscoveryError> {
        let msg = DiscoveryMessage::Register {
            profile: profile.clone(),
            signature: None,
        };

        // Cache the profile locally
        {
            let mut cache = self.agent_cache.lock().unwrap();
            cache.insert(profile.did.clone(), profile);
        }

        let resp = self.send_message(&msg).await.map_err(|e| {
            DiscoveryError::Internal(format!("TCP connect failed: {}", e))
        })?;

        match resp {
            DiscoveryMessage::RegisterResponse {
                success,
                lease,
                error,
            } => {
                if success {
                    lease.ok_or_else(|| {
                        DiscoveryError::Internal("Register succeeded but no lease".to_string())
                    })
                } else {
                    Err(DiscoveryError::Internal(
                        error.unwrap_or_else(|| "Register failed".to_string()),
                    ))
                }
            }
            _ => Err(DiscoveryError::Internal(
                "Unexpected response to Register".to_string(),
            )),
        }
    }

    async fn deregister(&self, did: &DID) -> Result<(), DiscoveryError> {
        // Get lease_id from cache (best effort)
        let msg = DiscoveryMessage::Deregister {
            did: did.clone(),
            lease_id: String::new(), // TODO: track lease_id
            signature: None,
        };

        let resp = self.send_message(&msg).await.map_err(|e| {
            DiscoveryError::Internal(format!("TCP connect failed: {}", e))
        })?;

        // Remove from local cache
        {
            let mut cache = self.agent_cache.lock().unwrap();
            cache.remove(did);
        }

        match resp {
            DiscoveryMessage::DeregisterResponse { success, error } => {
                if success {
                    Ok(())
                } else {
                    Err(DiscoveryError::Internal(
                        error.unwrap_or_else(|| "Deregister failed".to_string()),
                    ))
                }
            }
            _ => Err(DiscoveryError::Internal(
                "Unexpected response to Deregister".to_string(),
            )),
        }
    }

    async fn query(&self, req: QueryRequest) -> Result<Vec<AgentMatch>, DiscoveryError> {
        let msg = DiscoveryMessage::Query(req);

        let resp = self.send_message(&msg).await.map_err(|e| {
            DiscoveryError::Internal(format!("TCP connect failed: {}", e))
        })?;

        match resp {
            DiscoveryMessage::QueryResponse { matches, .. } => {
                // Update local cache from matches
                let mut cache = self.agent_cache.lock().unwrap();
                for m in &matches {
                    cache.insert(m.profile.did.clone(), m.profile.clone());
                }
                Ok(matches)
            }
            _ => Err(DiscoveryError::Internal(
                "Unexpected response to Query".to_string(),
            )),
        }
    }

    async fn heartbeat(&self, did: &DID, lease_id: &LeaseId) -> Result<Lease, DiscoveryError> {
        let msg = DiscoveryMessage::Heartbeat {
            did: did.clone(),
            lease_id: lease_id.clone(),
            metrics: None,
        };

        let resp = self.send_message(&msg).await.map_err(|e| {
            DiscoveryError::Internal(format!("TCP connect failed: {}", e))
        })?;

        match resp {
            DiscoveryMessage::HeartbeatResponse {
                lease_id,
                expires_at,
            } => Ok(Lease {
                lease_id,
                did: did.clone(),
                created_at: chrono::Utc::now(),  // best effort
                expires_at,
            }),
            _ => Err(DiscoveryError::Internal(
                "Unexpected response to Heartbeat".to_string(),
            )),
        }
    }

    async fn get_agent(&self, did: &DID) -> Option<AgentProfile> {
        let cache = self.agent_cache.lock().unwrap();
        cache.get(did).cloned()
    }

    async fn list_agents(&self) -> Vec<AgentProfile> {
        let cache = self.agent_cache.lock().unwrap();
        cache.values().cloned().collect()
    }
}
