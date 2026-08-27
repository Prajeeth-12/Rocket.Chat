---
'@rocket.chat/meteor': minor
---

Adds support for rate limiting REST endpoints per user rather than per IP address, through the new `per` option of `rateLimiterOptions`, and applies it to `chat.sendMessage` — users connecting from a shared address no longer compete for a single message allowance.
