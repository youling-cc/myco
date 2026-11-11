import json, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dsh_rpc

port, status = dsh_rpc.detect()
authority = f"127.0.0.1:{port}"
cookie = dsh_rpc.mint(authority)
print(json.dumps({"port": port, "status": status, "cookie": cookie}))

