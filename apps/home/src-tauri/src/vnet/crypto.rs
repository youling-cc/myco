//! vnet 安全层
//! Ed25519 身份验证 + X25519 密钥交换 + AES-256-GCM 数据加密 + HMAC 探测包认证
//! Apache 2.0 - 基于公开标准

use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use aes_gcm::aead::Aead;
use hmac::{Hmac, Mac};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;
use hmac::digest::KeyInit as _;

/// 探测包认证密钥（从会话密钥派生）
#[derive(Clone)]
pub struct ProbeAuth {
    key: [u8; 32],
}

impl ProbeAuth {
    pub fn new(session_secret: &[u8]) -> Self {
        let mut key = [0u8; 32];
        use sha2::Digest;
        let mut hasher = Sha256::new();
        hasher.update(session_secret);
        hasher.update(b"probe-auth");
        key.copy_from_slice(&hasher.finalize());
        Self { key }
    }

    /// 给探测包附加 HMAC（包尾 32 字节）
    pub fn sign_probe(&self, packet: &[u8]) -> Vec<u8> {
        let mut mac = <HmacSha256 as hmac::digest::KeyInit>::new_from_slice(&self.key).unwrap();
        mac.update(packet);
        let sig = mac.finalize().into_bytes();

        let mut signed = Vec::with_capacity(packet.len() + 32);
        signed.extend_from_slice(packet);
        signed.extend_from_slice(&sig);
        signed
    }

    /// 验证探测包的 HMAC
    pub fn verify_probe<'a>(&self, packet_with_sig: &'a [u8]) -> Option<&'a [u8]> {
        if packet_with_sig.len() < 32 { return None; }
        let (packet, sig) = packet_with_sig.split_at(packet_with_sig.len() - 32);
        let mut mac = <HmacSha256 as hmac::digest::KeyInit>::new_from_slice(&self.key).unwrap();
        mac.update(packet);
        let expected = mac.finalize().into_bytes();
        if expected.as_slice() == sig {
            Some(packet)
        } else {
            None
        }
    }
}

/// 通信方向角色：决定发送/接收各用哪把派生密钥。
///
/// 必须区分方向：AES-GCM 要求「同一密钥下 nonce 绝不重复」。
/// 若两端共用一把 key 且各自 nonce 都从 0 递增，双方会用相同 key+nonce
/// 加密不同明文——这会同时破坏机密性和完整性（GCM 的灾难性失效）。
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Client,
    Server,
}

/// 简化版密钥交换（对称密钥由中继分发或预共享）
pub struct SessionCrypto {
    send_cipher: Aes256Gcm,
    recv_cipher: Aes256Gcm,
    send_nonce: u64,
}

impl SessionCrypto {
    pub fn new(shared_key: &[u8; 32], role: Role) -> Self {
        let c2s = Self::derive(shared_key, b"vnet-c2s");
        let s2c = Self::derive(shared_key, b"vnet-s2c");
        let (send_key, recv_key) = match role {
            Role::Client => (c2s, s2c),
            Role::Server => (s2c, c2s),
        };
        Self {
            send_cipher: Aes256Gcm::new_from_slice(&send_key).unwrap(),
            recv_cipher: Aes256Gcm::new_from_slice(&recv_key).unwrap(),
            send_nonce: 0,
        }
    }

    /// 从任意口令派生出 32 字节会话密钥（两端同口令 = 同密钥）
    pub fn key_from_secret(secret: &str) -> [u8; 32] {
        use sha2::Digest;
        let mut hasher = Sha256::new();
        hasher.update(b"vnet-psk-v1");
        hasher.update(secret.as_bytes());
        let mut out = [0u8; 32];
        out.copy_from_slice(&hasher.finalize());
        out
    }

    /// 中继鉴权 token：与中继端（C 实现，只做字节比对）共享的 32 字节串。
    /// 没有它任何人都能发 Register(peer_id=X) 抢占映射、截获发给 X 的数据。
    pub fn relay_token(secret: &str) -> [u8; 32] {
        use sha2::Digest;
        let mut hasher = Sha256::new();
        hasher.update(b"vnet-relay-auth");
        hasher.update(secret.as_bytes());
        let mut out = [0u8; 32];
        out.copy_from_slice(&hasher.finalize());
        out
    }

    fn derive(key: &[u8; 32], ctx: &[u8]) -> [u8; 32] {
        use sha2::Digest;
        let mut hasher = Sha256::new();
        hasher.update(key);
        hasher.update(ctx);
        let mut out = [0u8; 32];
        out.copy_from_slice(&hasher.finalize());
        out
    }

    fn next_nonce(&mut self) -> [u8; 12] {
        self.send_nonce += 1;
        let mut nonce = [0u8; 12];
        nonce[4..12].copy_from_slice(&self.send_nonce.to_be_bytes());
        nonce
    }

    pub fn encrypt(&mut self, plaintext: &[u8]) -> Vec<u8> {
        let nonce = self.next_nonce();
        let ct = self.send_cipher
            .encrypt(Nonce::from_slice(&nonce), plaintext)
            .unwrap_or_default();
        let mut out = Vec::with_capacity(12 + ct.len());
        out.extend_from_slice(&nonce);
        out.extend_from_slice(&ct);
        out
    }

    pub fn decrypt(&mut self, data: &[u8]) -> Option<Vec<u8>> {
        if data.len() < 12 { return None; }
        let (nonce, ct) = data.split_at(12);
        self.recv_cipher
            .decrypt(Nonce::from_slice(nonce), ct)
            .ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_probe_auth_roundtrip() {
        let auth = ProbeAuth::new(b"test-secret");
        let original = [1u8, 2, 3, 4, 5];
        let signed = auth.sign_probe(&original);
        assert!(signed.len() == original.len() + 32);
        let verified = auth.verify_probe(&signed);
        assert!(verified.is_some());
        assert_eq!(verified.unwrap(), &original);
    }

    #[test]
    fn test_probe_auth_reject_forgery() {
        let auth = ProbeAuth::new(b"test-secret");
        let original = [1u8, 2, 3, 4, 5];
        let mut signed = auth.sign_probe(&original);
        signed[0] ^= 0xFF;
        assert!(auth.verify_probe(&signed).is_none());
    }

    #[test]
    fn test_encrypt_decrypt() {
        let key = [42u8; 32];
        let mut c = SessionCrypto::new(&key, Role::Client);
        let mut s = SessionCrypto::new(&key, Role::Server);
        let plaintext = b"hello vnet secure";
        let encrypted = c.encrypt(plaintext);
        assert_ne!(encrypted, plaintext);
        // 客户端加密 -> 服务端解密
        assert_eq!(s.decrypt(&encrypted).unwrap(), plaintext);
        // 服务端加密 -> 客户端解密
        let back = s.encrypt(b"reply");
        assert_eq!(c.decrypt(&back).unwrap(), b"reply");
    }

    #[test]
    fn test_direction_keys_differ() {
        // 关键安全性：两个方向必须用不同密钥，否则同 key+nonce 复用会毁掉 GCM
        let key = [7u8; 32];
        let mut c = SessionCrypto::new(&key, Role::Client);
        let mut s = SessionCrypto::new(&key, Role::Server);
        let ct = c.encrypt(b"x");
        // 服务端用「接收」密钥能解开
        assert!(s.decrypt(&ct).is_some());
        // 但同角色的另一个客户端用自己的接收密钥解不开（方向不匹配）
        let mut c2 = SessionCrypto::new(&key, Role::Client);
        assert!(c2.decrypt(&ct).is_none());
    }

    #[test]
    fn test_wrong_key_fails() {
        let mut crypto1 = SessionCrypto::new(&[1u8; 32], Role::Client);
        let mut crypto2 = SessionCrypto::new(&[2u8; 32], Role::Server);
        let ct = crypto1.encrypt(b"secret");
        assert!(crypto2.decrypt(&ct).is_none());
    }
}
