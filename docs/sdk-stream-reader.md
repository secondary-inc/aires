---
title: SDK streaming reader compatibility
---

The TypeScript query tailer requires only the standard reader read and cancel
methods. Its type must not require Bun-specific readMany: fetch response bodies
may use the standard Web Streams reader even when Bun global types are loaded.
Version 0.5.2 narrows the stored reader contract without casts or runtime changes.
The mismatch was observed in a fresh Workforce Project build using current Bun
types and @aires/sdk 0.5.1; live consumption verification is pending publication.
