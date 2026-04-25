# pi-tailscale-server — Progress

Minimal WebSocket server wrapping pi. See `pi-tailscale-android/PROGRESS.md` for full status.

## Completed
- WebSocket server with per-thread sessions
- Directory listing + `/dir` command
- Model switching from pi's ModelRegistry
- Thread ID tagging on all streaming frames
- Text selection working

## Known Issues
- `/dir` with nonexistent path sends ERROR as text_delta (should use error frame type)
- No connection auth — any client on the Tailscale network can connect
- Sessions never cleaned up (leak over time)
