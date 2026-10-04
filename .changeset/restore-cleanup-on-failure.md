---
"alineo": patch
---

Fix a container leak in `resumeAgent()`/`reattachAgent()`'s restore-from-checkpoint fallback
(3.3): if a step after provisioning the fresh container (extracting the checkpoint, restarting
the bridge) failed, the already-running fresh container was never closed, and a caller's own
retry provisioned yet another one on top of it. Found live on `my-vps` during M3's end-to-end
verification — two orphaned containers from one restore attempt.
