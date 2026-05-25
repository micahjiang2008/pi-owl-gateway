# pi-owl-gateway

Multi-platform messaging gateway daemon for [pi](https://pi.dev).  
Currently supports **WeChat** (via Tencent iLink Bot API). Telegram and more coming.

## Install

```bash
npm install -g git+https://github.com/micahjiang2008/pi-owl-gateway.git
```

## Quick Start

```bash
# WeChat QR login
pi-owl-gateway login -p weixin

# Start daemon
pi-owl-gateway start

# Check status
pi-owl-gateway status

# Stop daemon
pi-owl-gateway stop

# Restart
pi-owl-gateway restart
```

## Configuration

Credentials and settings are stored in `~/.pi/agent/settings.json`:

```json
{
  "gateway": {
    "workDir": "~/.pi/gateway-workspace"
  }
}
```

- `gateway.workDir` — workspace directory for AI sessions (default: `~/.pi/gateway-workspace`)

## How It Works

```
WeChat App  ←→  iLink Bot API  ←→  pi-owl-gateway daemon  ←→  pi SDK  ←→  LLM
```

1. Daemon polls WeChat for new messages (long-poll, 35s timeout)
2. Messages are forwarded to pi SDK's AgentSession for AI processing
3. AI response is sent back to WeChat

## Platform Support

| Platform | Status |
|----------|--------|
| WeChat   | ✅ Working |
| Telegram | ❌ Not yet |

## Requirements

- Node.js >= 18
- pi (`npm install -g @earendil-works/pi-coding-agent`)
- A WeChat personal account (for QR login)

## License

MIT
