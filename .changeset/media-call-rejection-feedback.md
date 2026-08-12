---
'@rocket.chat/media-signaling': minor
'@rocket.chat/media-calls': minor
'@rocket.chat/ui-voip': minor
'@rocket.chat/i18n': minor
'@rocket.chat/meteor': minor
---

Tells the caller why a voice call they placed was rejected, instead of showing the call widget for an instant and nothing else. An app that blocks a call through `IMediaCallHandler` can now have its own message shown to the caller, and rejections the server was already sending — the callee being unavailable, the caller not being allowed to place the call — are explained rather than silent
