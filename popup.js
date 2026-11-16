/**
 * Soofi Mandi — reusable premium popup system (customer site + admin dashboard).
 *
 *   SoofiPopup.show({ type, title, message, actions, key, dismissible }) -> Promise<actionValue|null>
 *   SoofiPopup.error(kind, overrides)  -> preset friendly error (see PRESETS)
 *   SoofiPopup.confirm({ title, message, confirmLabel, cancelLabel, type }) -> Promise<boolean>
 *   SoofiPopup.closeAll()
 *
 * - One popup is visible at a time; distinct popups queue (max 3 waiting).
 * - A popup with the same key as one showing or queued is ignored (no duplicates).
 * - Messages are customer-friendly only; never pass raw server/technical text here.
 * - Escape / backdrop closes dismissible popups; focus returns to the previous element.
 * Styles are injected once and use the site's navy & gold palette.
 */
(function () {
  "use strict";
  if (window.SoofiPopup) return;

  const ICONS = {
    error: '<path d="M24 5 3.5 41h41L24 5Z" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linejoin="round"/><path d="M24 18v11" stroke="currentColor" stroke-width="3.6" stroke-linecap="round"/><circle cx="24" cy="34.5" r="2.3" fill="currentColor"/>',
    network: '<path d="M6 18.5a26 26 0 0 1 36 0M11.5 24.5a18 18 0 0 1 25 0M17.5 30.5a9.5 9.5 0 0 1 13 0" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round"/><circle cx="24" cy="37" r="2.6" fill="currentColor"/><path d="M8 8l32 32" stroke="currentColor" stroke-width="3.2" stroke-linecap="round"/>',
    server: '<rect x="8" y="7" width="32" height="13" rx="4" fill="none" stroke="currentColor" stroke-width="3"/><rect x="8" y="26" width="32" height="13" rx="4" fill="none" stroke="currentColor" stroke-width="3"/><circle cx="15" cy="13.5" r="2" fill="currentColor"/><circle cx="15" cy="32.5" r="2" fill="currentColor"/><path d="M22 13.5h11M22 32.5h11" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>',
    lock: '<rect x="9" y="21" width="30" height="21" rx="5" fill="none" stroke="currentColor" stroke-width="3.2"/><path d="M16 21v-6a8 8 0 0 1 16 0v6" fill="none" stroke="currentColor" stroke-width="3.2"/><circle cx="24" cy="31.5" r="3" fill="currentColor"/>',
    phone: '<rect x="13" y="4" width="22" height="40" rx="5" fill="none" stroke="currentColor" stroke-width="3.2"/><path d="M20 37h8" stroke="currentColor" stroke-width="3.2" stroke-linecap="round"/><path d="M19 15h10M19 21h7" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>',
    gift: '<rect x="6" y="18" width="36" height="9" rx="2.5" fill="none" stroke="currentColor" stroke-width="3"/><rect x="9" y="27" width="30" height="15" rx="2.5" fill="none" stroke="currentColor" stroke-width="3"/><path d="M24 18v24M24 18c-3-7-12-8-12-3s12 3 12 3Zm0 0c3-7 12-8 12-3s-12 3-12 3Z" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round"/>',
    question: '<circle cx="24" cy="24" r="19" fill="none" stroke="currentColor" stroke-width="3.2"/><path d="M18.5 18.5a5.8 5.8 0 1 1 8.3 5.2c-1.9.9-2.8 2.2-2.8 4.3" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round"/><circle cx="24" cy="34" r="2.3" fill="currentColor"/>',
    success: '<circle cx="24" cy="24" r="19" fill="none" stroke="currentColor" stroke-width="3.2"/><path d="m15 24.5 6.2 6.2L33.5 18" fill="none" stroke="currentColor" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/>'
  };

  // Friendly presets. `retry` actions are wired by callers via overrides.actions.
  const PRESETS = {
    network: { icon: "network", title: "You're offline", message: "We couldn't reach Soofi Mandi. Check your internet connection and try again." },
    server: { icon: "server", title: "Something went wrong", message: "Our server had a hiccup. Please try again in a moment." },
    session: { icon: "lock", title: "Please sign in again", message: "Your session has ended. Sign in again to continue." },
    otpUnavailable: { icon: "phone", title: "OTP service unavailable", message: "We can't send OTPs right now. Refresh the page or try again later." },
    otpSend: { icon: "phone", title: "Couldn't send OTP", message: "We couldn't send an OTP to that number. Check the number and try again." },
    otpVerify: { icon: "phone", title: "OTP not verified", message: "That OTP is incorrect or has expired. Check the code or request a new one." },
    otpResend: { icon: "phone", title: "Couldn't resend OTP", message: "Please wait for the timer to finish, then try resending the OTP." },
    signIn: { icon: "lock", title: "Sign-in failed", message: "We couldn't complete your sign-in. Please try again." },
    scoreVerify: { icon: "error", title: "Score not verified yet", message: "We couldn't confirm your score with our server. Tap retry to check again." },
    claim: { icon: "gift", title: "Couldn't unlock your offer", message: "Something stopped your offer from unlocking. Please try again." },
    generic: { icon: "error", title: "Something went wrong", message: "Please try again." }
  };

  const STYLE = `
.sm-popup-backdrop{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:16px;
  background:radial-gradient(120% 90% at 50% 40%,rgba(10,23,48,.72) 0%,rgba(3,8,18,.86) 100%);
  -webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);opacity:0;transition:opacity .22s ease}
.sm-popup-backdrop.is-open{opacity:1}
.sm-popup{position:relative;width:100%;max-width:400px;box-sizing:border-box;text-align:center;overflow:hidden;
  padding:26px clamp(18px,5vw,26px) 20px;border-radius:22px;color:#FFF8E7;
  font-family:"Poppins",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  background:radial-gradient(120% 70% at 50% 0%,rgba(245,184,0,.16) 0%,rgba(245,184,0,0) 60%),linear-gradient(160deg,#12264A 0%,#0A1730 55%,#060F22 100%);
  border:1.5px solid rgba(245,184,0,.6);
  box-shadow:0 24px 60px rgba(0,0,0,.6),0 0 28px rgba(245,184,0,.18),inset 0 1px 0 rgba(255,233,160,.18);
  transform:translateY(14px) scale(.94);opacity:0;transition:transform .32s cubic-bezier(.2,.9,.25,1.15),opacity .22s ease}
.sm-popup-backdrop.is-open .sm-popup{transform:none;opacity:1}
.sm-popup::before{content:"";position:absolute;top:0;left:18%;right:18%;height:2px;background:linear-gradient(90deg,rgba(255,210,77,0),#FFD24D 50%,rgba(255,210,77,0))}
.sm-popup-icon{width:60px;height:60px;margin:0 auto 14px;border-radius:50%;display:flex;align-items:center;justify-content:center;
  color:#FFD24D;background:radial-gradient(circle at 50% 35%,rgba(255,210,77,.22) 0%,rgba(10,23,48,.95) 72%);
  border:1.5px solid rgba(255,210,77,.75);box-shadow:0 0 0 5px rgba(245,184,0,.08),0 0 20px rgba(245,184,0,.3)}
.sm-popup-icon svg{width:30px;height:30px}
.sm-popup.is-danger .sm-popup-icon{color:#FF9A7A;border-color:rgba(255,138,112,.75);box-shadow:0 0 0 5px rgba(255,107,74,.08),0 0 20px rgba(255,107,74,.28)}
.sm-popup.is-success .sm-popup-icon{color:#7BD88F;border-color:rgba(123,216,143,.75);box-shadow:0 0 0 5px rgba(123,216,143,.08),0 0 20px rgba(123,216,143,.28)}
.sm-popup-title{margin:0 0 8px;font-size:clamp(17px,4.6vw,19px);font-weight:800;letter-spacing:.01em;line-height:1.3;
  background:linear-gradient(180deg,#FFF6D8 0%,#FFD24D 60%,#F5B800 100%);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
.sm-popup-message{margin:0 auto;max-width:330px;font-size:clamp(13.5px,3.7vw,14.5px);line-height:1.55;font-weight:500;color:#F3E7CC}
.sm-popup-actions{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:20px}
.sm-popup-btn{flex:1 1 130px;max-width:180px;min-height:44px;padding:10px 18px;border-radius:999px;cursor:pointer;
  font-family:inherit;font-size:13px;font-weight:800;line-height:1.2;letter-spacing:.06em;text-transform:uppercase;transition:transform .15s ease,box-shadow .2s ease,background .2s ease}
.sm-popup-btn.is-primary{border:none;color:#2A1408;background:linear-gradient(135deg,#FFD24D 0%,#F5B800 60%,#D99E00 100%);box-shadow:0 6px 18px rgba(245,184,0,.32)}
.sm-popup-btn.is-primary:hover{transform:translateY(-1px);box-shadow:0 8px 22px rgba(245,184,0,.45)}
.sm-popup-btn.is-secondary{color:#FFD24D;background:rgba(10,23,48,.6);border:1.5px solid rgba(245,184,0,.55)}
.sm-popup-btn.is-secondary:hover{background:rgba(245,184,0,.1)}
.sm-popup-btn:focus-visible{outline:2px solid #FFF3C4;outline-offset:3px}
.sm-popup-close{position:absolute;top:10px;right:10px;width:34px;height:34px;border-radius:50%;border:none;cursor:pointer;
  background:transparent;color:rgba(255,248,231,.65);font-size:20px;line-height:1}
.sm-popup-close:hover{color:#FFD24D;background:rgba(245,184,0,.1)}
@media (prefers-reduced-motion:reduce){.sm-popup-backdrop,.sm-popup{transition:opacity .15s ease}.sm-popup{transform:none}}
`;

  let styleInjected = false;
  function injectStyle() {
    if (styleInjected) return;
    const tag = document.createElement("style");
    tag.setAttribute("data-soofi-popup", "");
    tag.textContent = STYLE;
    document.head.appendChild(tag);
    styleInjected = true;
  }

  const queue = [];
  let current = null;

  function keyOf(opts) {
    return opts.key || `${opts.title}|${opts.message}`;
  }

  function show(options) {
    const opts = Object.assign({ type: "error", dismissible: true }, options || {});
    const key = keyOf(opts);
    if (current && current.key === key) return current.promise;
    const queued = queue.find((item) => item.key === key);
    if (queued) return queued.promise;
    let resolveFn;
    const promise = new Promise((resolve) => { resolveFn = resolve; });
    const entry = { key, opts, promise, resolve: resolveFn };
    if (queue.length >= 3) queue.shift().resolve(null); // keep the newest few
    queue.push(entry);
    if (!current) next();
    return promise;
  }

  function next() {
    const entry = queue.shift();
    if (!entry) { current = null; return; }
    current = entry;
    render(entry);
  }

  function render(entry) {
    injectStyle();
    const o = entry.opts;
    const iconName = o.icon || (o.type === "confirm" ? "question" : o.type === "success" ? "success" : o.type === "network" ? "network" : "error");
    const actions = Array.isArray(o.actions) && o.actions.length ? o.actions : [{ label: "OK", value: "ok", primary: true }];
    const previousFocus = document.activeElement;

    const backdrop = document.createElement("div");
    backdrop.className = "sm-popup-backdrop";
    backdrop.setAttribute("data-popup-key", entry.key);
    const card = document.createElement("div");
    card.className = "sm-popup" + (o.tone === "danger" ? " is-danger" : o.type === "success" ? " is-success" : "");
    card.setAttribute("role", "alertdialog");
    card.setAttribute("aria-modal", "true");
    const titleId = "sm-popup-title-" + Math.random().toString(36).slice(2, 8);
    const msgId = titleId + "-msg";
    card.setAttribute("aria-labelledby", titleId);
    card.setAttribute("aria-describedby", msgId);

    const icon = document.createElement("div");
    icon.className = "sm-popup-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = `<svg viewBox="0 0 48 48" focusable="false">${ICONS[iconName] || ICONS.error}</svg>`;
    const title = document.createElement("h2");
    title.className = "sm-popup-title";
    title.id = titleId;
    title.textContent = o.title || "Something went wrong";
    const message = document.createElement("p");
    message.className = "sm-popup-message";
    message.id = msgId;
    message.textContent = o.message || "";

    const row = document.createElement("div");
    row.className = "sm-popup-actions";
    const buttons = actions.map((action) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "sm-popup-btn " + (action.primary ? "is-primary" : "is-secondary");
      btn.textContent = action.label;
      btn.setAttribute("data-popup-action", action.value || action.label);
      btn.addEventListener("click", () => close(action.value !== undefined ? action.value : action.label, action.onClick));
      row.appendChild(btn);
      return btn;
    });

    card.append(icon, title, message, row);
    if (o.dismissible) {
      const x = document.createElement("button");
      x.type = "button";
      x.className = "sm-popup-close";
      x.setAttribute("aria-label", "Close");
      x.textContent = "×";
      x.addEventListener("click", () => close(null));
      card.appendChild(x);
    }
    backdrop.appendChild(card);
    document.body.appendChild(backdrop);
    requestAnimationFrame(() => backdrop.classList.add("is-open"));

    const onKey = (event) => {
      if (event.key === "Escape" && o.dismissible) { event.preventDefault(); close(null); }
      if (event.key === "Tab") { // keep focus inside the popup
        const focusables = [...card.querySelectorAll("button")];
        const first = focusables[0], last = focusables[focusables.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener("keydown", onKey, true);
    backdrop.addEventListener("click", (event) => { if (event.target === backdrop && o.dismissible) close(null); });
    const primary = buttons.find((b) => b.classList.contains("is-primary")) || buttons[0];
    setTimeout(() => primary && primary.focus({ preventScroll: true }), 30);

    let closed = false;
    function close(value, onClick) {
      if (closed) return;
      closed = true;
      document.removeEventListener("keydown", onKey, true);
      backdrop.classList.remove("is-open");
      setTimeout(() => {
        backdrop.remove();
        if (previousFocus && typeof previousFocus.focus === "function" && document.contains(previousFocus)) {
          try { previousFocus.focus({ preventScroll: true }); } catch (_) {}
        }
        entry.resolve(value);
        if (typeof onClick === "function") { try { onClick(); } catch (_) {} }
        next();
      }, 200);
    }
    entry.close = close;
  }

  function error(kind, overrides) {
    const preset = PRESETS[kind] || PRESETS.generic;
    const opts = Object.assign({ type: "error", key: kind }, preset, overrides || {});
    return show(opts);
  }

  function confirm(options) {
    const o = options || {};
    return show({
      type: "confirm",
      icon: o.icon || "question",
      tone: o.tone,
      key: o.key || `confirm|${o.title}|${o.message}`,
      title: o.title || "Are you sure?",
      message: o.message || "",
      dismissible: true,
      actions: [
        { label: o.cancelLabel || "Cancel", value: false },
        { label: o.confirmLabel || "Confirm", value: true, primary: true }
      ]
    }).then((value) => value === true);
  }

  function closeAll() {
    while (queue.length) queue.shift().resolve(null);
    if (current && current.close) current.close(null);
  }

  // Quick classifier for fetch failures: offline / network vs server error.
  function isNetworkError(err) {
    return !navigator.onLine || (err && (err.name === "TypeError" || /network|fetch|timeout|abort/i.test(String(err.message || ""))));
  }

  window.SoofiPopup = { show, error, confirm, closeAll, isNetworkError, PRESETS };
})();
