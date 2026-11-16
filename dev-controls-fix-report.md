# Soofi Mandi Dev Controls Security Review

## Current State

### What's Already Working ✓
1. **Server-side HTML Stripping** (`server.js:338`): Regex strips `<aside class="dev-test-panel">` when serving `index.html` in production
2. **Feature Guards** (`app.js:3000-3007`): Functions like `forceSpawnGoldenMandi` check `isLocalDev` and log warning in production
3. **Score Test Guards** (`app.js:3046-3048`): `testOfferUnlock` rejects when not in local development

### The Problem ✗
**Client-side detection uses hostname check, not NODE_ENV**:
```javascript
// app.js:2989-2996 - Only checks hostname
const isLocalDev = Boolean(
  typeof window !== "undefined" &&
  (window.location.hostname === "localhost" ||
   window.location.hostname === "127.0.0.1" ||
   window.location.hostname === "0.0.0.0" ||
   window.location.hostname === "[::1]" ||
   window.location.hostname.startsWith("192.168.") ||
   window.location.hostname.endsWith(".local"))
);
```

This means if:
- Browser cache serves old HTML with dev panel
- CDN cache delivers dev panel HTML

Dev controls would appear.

---

## Required Changes

### 1. Update `app.js` - Add NODE_ENV check to isLocalDev

Replace the hostname-only check with a combined check of:
- NODE_ENV === 'test' (tests always detect dev)
- NODE_ENV === 'development'
- Localhost hostname OR NODE_ENV === 'production' with LOCAL_DEV=1

### 2. Add Inline Environment Marker in index.html

Add a comment or data attribute to index.html stamped with whether it will be served in production, so the client JS can verify structural integrity.

---

## Changed Files
- app.js - isLocalDev function
- index.html - add environment marker comment

---

## Testing Checklist
- [ ] Local development: Dev Controls visible
- [ ] Production mode locally (NODE_ENV=production): Dev Controls hidden
- [ ] Production APIs: developer-only actions rejected
- [ ] Normal gameplay and offer claims still work