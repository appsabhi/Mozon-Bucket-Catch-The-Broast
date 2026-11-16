(() => {
  "use strict";

  // =========================================================================
  // DOM CONTAINERS & VIEWS
  // =========================================================================
  const container = document.getElementById("white-container");
  const loginScreen = document.getElementById("login-screen");
  const loginPhoneForm = document.getElementById("login-phone-form");
  const loginOtpForm = document.getElementById("login-otp-form");
  const loginMobileInput = document.getElementById("login-mobile");
  const loginError = document.getElementById("login-error");
  const otpError = document.getElementById("otp-error");
  const otpMobileDisplay = document.getElementById("otp-mobile-display");
  const otpPreviewNote = document.getElementById("otp-preview-note");
  const otpInputs = Array.from(document.querySelectorAll(".otp-inputs input"));
  let isAuthenticated = false;
  let otpCountdownTimer = null;
  const GAME_OVER_STATE_KEY = "soofi_mandi_game_over_state";
  const PLAYING_GAME_STATE_KEY = "soofi_mandi_playing_game_state";
  const viewIntro = document.getElementById("view-intro");
  const viewPlaying = document.getElementById("view-playing");
  const viewResults = document.getElementById("view-results");
  const rewardCard = document.getElementById("reward-card");

  // Game UI & HUD Elements
  const startGameBtn = document.getElementById("start-game-btn") || document.getElementById("play-now-btn");
  const playAgainBtn = document.getElementById("play-again-btn");
  const resetBtn = document.getElementById("reset-btn");
  const introResetBtn = document.getElementById("intro-reset-btn");
  const rewardResetBtn = document.getElementById("reward-reset-btn");
  const gameMissesEl = document.getElementById("game-misses");
  const hudMissesEl = document.getElementById("hud-misses");
  const hudMissWarningEl = document.getElementById("hud-miss-warning");
  const gameScoreEl = document.getElementById("game-score");
  const gamePlayArea = document.getElementById("game-play-area");
  const fallingItemsLayer = document.getElementById("falling-items-layer");

  // Enhanced HUD Elements (Combo multiplier x2)
  const hudEnhancementsStrip = document.getElementById("hud-enhancements-strip");
  const hudComboEl = document.getElementById("hud-combo");
  const hudComboValEl = document.getElementById("hud-combo-val");

  // Pause / Resume Controls & Overlay Elements
  const hudPauseBtn = document.getElementById("hud-pause-btn");
  const gamePauseOverlay = document.getElementById("game-pause-overlay");
  const resumeGameBtn = document.getElementById("resume-game-btn");
  const pauseStatScore = document.getElementById("pause-stat-score");
  const pauseStatCombo = document.getElementById("pause-stat-combo");
  const pauseStatMisses = document.getElementById("pause-stat-misses");

  // 3D Layered Bucket Elements
  const bucketRear = document.getElementById("bucket-rear");
  const bucketFront = document.getElementById("bucket-front");
  const bucketDragIndicator = document.getElementById("bucket-drag-indicator");

  // Results, Loss & Offer Display Elements
  const interstitialScoreVal = document.getElementById("interstitial-score-val");
  const interstitialScoreDesc = document.getElementById("interstitial-score-desc");
  const rewardScoreNumber = document.getElementById("reward-score-number");
  const rewardScoreSummary = document.getElementById("reward-score-summary");
  const rewardResultHeader = document.getElementById("reward-result-header");
  const rewardLossHeadline = document.getElementById("reward-loss-headline");
  const rewardKicker = document.getElementById("reward-kicker");
  const rewardOfferCard = document.getElementById("reward-offer-card");
  const offerTitle = document.getElementById("offer-title");
  const offerDescription = document.getElementById("offer-description");

  // Offer Unlock & Claim Modal Elements
  const rewardLockedWrap = document.getElementById("reward-locked-wrap");
  const offerLockedBtn = document.getElementById("offer-locked-btn");
  const rewardUnlockBanner = document.getElementById("reward-unlock-banner");
  const unlockScoreVal = document.getElementById("unlock-score-val");
  const unlockCongratsText = document.getElementById("unlock-congrats-text");
  const unlockOfferBtn = document.getElementById("unlock-offer-btn");
  const unlockOfferError = document.getElementById("unlock-offer-error");
  const offerCongratsHeadline = document.getElementById("offer-congrats-headline");
  const offerClaimCode = document.getElementById("offer-claim-code");
  const offerInstructionsText = document.getElementById("offer-instructions-text");
  const OFFER_REDEEM_INSTRUCTIONS = "Take a screenshot of this offer and show it to our staff to redeem your reward.";
  const offerStatusText = document.getElementById("offer-status-text");

  const claimModal = document.getElementById("claim-modal");
  const closeClaimModalBtn = document.getElementById("close-claim-modal-btn");
  const claimForm = document.getElementById("claim-form");
  const claimNameInput = document.getElementById("claim-name");
  const claimNameError = document.getElementById("claim-name-error");
  const claimPhoneInput = document.getElementById("claim-phone");
  const claimPhoneError = document.getElementById("claim-phone-error");
  const claimEmailInput = document.getElementById("claim-email");
  const claimEmailError = document.getElementById("claim-email-error");
  const claimAlertError = document.getElementById("claim-alert-error");
  const claimSubmitBtn = document.getElementById("claim-submit-btn");
  const claimSpinner = document.getElementById("claim-spinner");
  const claimSubmitText = document.getElementById("claim-submit-text");

  let currentGameSessionId = null;
  let currentGameSessionPromise = null;
  let currentClaim = null;
  let pendingScoreSubmission = null;
  let currentRoundId = 0;
  // Server score verification for the finished round. The offer UI is driven ONLY by a
  // server-verified score: status "pending" | "verified" | "failed".
  //   payload       - the exact submission, resent unchanged (same gameSessionId) on retry
  //   verifiedScore - score returned by the server after verification
  let scoreVerification = { status: "idle", roundId: null, payload: null, verifiedScore: null, gameSessionId: null };
  // All customer-facing errors use the shared premium popup (popup.js). Messages are friendly
  // presets; technical details stay in server logs. Duplicate popups are ignored by key.
  function showErrorPopup(kind, overrides) {
    if (window.SoofiPopup) return window.SoofiPopup.error(kind, overrides);
    return Promise.resolve(null);
  }
  const scoreVerifyStatus = document.getElementById("score-verify-status");
  const scoreVerifyText = document.getElementById("score-verify-text");
  const scoreVerifyRetry = document.getElementById("score-verify-retry");

  // MSG91 widget integration for the existing custom login UI (Phase 1 only).
  if (loginPhoneForm && loginOtpForm && loginScreen) {
    const loginSendButton = loginPhoneForm.querySelector('button[type="submit"]');
    const loginVerifyButton = loginOtpForm.querySelector('button[type="submit"]');
    const resendOtpButton = document.getElementById("resend-otp-btn");
    const resendCountdown = document.getElementById("otp-countdown");
    const resendLabel = document.getElementById("otp-resend-label");
    let otpIdentifier = "";
    let otpVerifiedInWidget = false;

    // hCaptcha (used by the MSG91 widget) rejects localhost / loopback hosts.
    function isLocalOtpHost() {
      return /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/i.test(window.location.hostname);
    }

    // OTP failures are shown in the shared premium popup with friendly wording only; the MSG91
    // error details are never shown to customers.
    function showOtpError(action, error) {
      let detail = typeof error === "string" ? error : (error instanceof Error ? error.message : "");
      if (!detail && error && typeof error === "object") {
        try { detail = JSON.stringify(error); } catch (_) {}
      }
      if (action === "send" && isLocalOtpHost()) {
        return showErrorPopup("otpSend", {
          message: "OTP can't be sent from localhost because MSG91's captcha only works on a real domain. Test OTP on the live site."
        });
      }
      if (!navigator.onLine || /network|fetch|timeout|connection/i.test(detail)) {
        return showErrorPopup("network", { key: `otp-${action}-network` });
      }
      if (action === "verify") return showErrorPopup("otpVerify");
      if (action === "resend") return showErrorPopup("otpResend");
      return showErrorPopup("otpSend");
    }

    function startOtpCountdown() {
      let seconds = 30;
      if (resendCountdown) {
        resendCountdown.textContent = String(seconds);
        resendCountdown.hidden = false;
      }
      if (resendLabel) resendLabel.textContent = "Resend OTP in";
      if (resendOtpButton) resendOtpButton.disabled = true;
      window.clearInterval(otpCountdownTimer);
      otpCountdownTimer = window.setInterval(() => {
        seconds -= 1;
        if (resendCountdown) resendCountdown.textContent = String(seconds);
        if (seconds <= 0) {
          window.clearInterval(otpCountdownTimer);
          if (resendOtpButton) resendOtpButton.disabled = false;
          if (resendLabel) resendLabel.textContent = "Didn't receive it?";
          if (resendCountdown) resendCountdown.hidden = true;
        }
      }, 1000);
    }

    function setSdkUnavailableMessage(target) {
      if (target) target.textContent = "";
      showErrorPopup("otpUnavailable", {
        actions: [
          { label: "Close", value: "close" },
          { label: "Refresh page", value: "refresh", primary: true, onClick: () => window.location.reload() }
        ]
      });
    }

    loginPhoneForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const digits = (loginMobileInput.value || "").replace(/\D/g, "");
      if (digits.length !== 10) {
        loginError.textContent = "Enter a valid 10-digit Indian mobile number.";
        loginMobileInput.focus();
        return;
      }
      if (typeof window.sendOtp !== "function") {
        setSdkUnavailableMessage(loginError);
        return;
      }

      loginError.textContent = "";
      loginSendButton.disabled = true;
      loginSendButton.textContent = "Sending OTP…";
      otpIdentifier = `91${digits}`;
      let callbackHandled = false;
      // The MSG91 widget runs hCaptcha first. If the captcha fails (e.g. hCaptcha refuses
      // localhost) the widget may never call back, so never leave the button stuck.
      const sendWatchdog = window.setTimeout(() => {
        if (callbackHandled) return;
        callbackHandled = true;
        loginSendButton.disabled = false;
        loginSendButton.textContent = "Send OTP";
        showOtpError("send", "timeout");
      }, 20000);
      const onSent = () => {
        if (callbackHandled) return;
        callbackHandled = true;
        window.clearTimeout(sendWatchdog);
        loginSendButton.disabled = false;
        loginSendButton.textContent = "Send OTP";
        otpMobileDisplay.textContent = `+91 ${digits}`;
        loginPhoneForm.hidden = true;
        loginOtpForm.hidden = false;
        otpPreviewNote.hidden = true;
        otpError.textContent = "";
        otpInputs.forEach((input) => { input.value = ""; });
        startOtpCountdown();
        otpInputs[0].focus();
      };
      const onSendFailed = (error) => {
        if (callbackHandled) return;
        callbackHandled = true;
        window.clearTimeout(sendWatchdog);
        loginSendButton.disabled = false;
        loginSendButton.textContent = "Send OTP";
        showOtpError("send", error);
      };
      try {
        // MSG91 Web SDK expects the country code without a leading plus.
        window.sendOtp(otpIdentifier, onSent, onSendFailed);
      } catch (error) {
        onSendFailed(error);
      }
    });
    otpInputs.forEach((input, index) => {
      input.addEventListener("input", () => {
        input.value = input.value.replace(/\D/g, "").slice(-1);
        if (input.value && otpInputs[index + 1]) otpInputs[index + 1].focus();
      });
      input.addEventListener("keydown", (event) => {
        if (event.key === "Backspace" && !input.value && otpInputs[index - 1]) otpInputs[index - 1].focus();
      });
      input.addEventListener("paste", (event) => {
        const pasted = (event.clipboardData || window.clipboardData).getData("text").replace(/\D/g, "").slice(0, 4);
        if (!pasted) return;
        event.preventDefault();
        pasted.split("").forEach((digit, digitIndex) => { if (otpInputs[digitIndex]) otpInputs[digitIndex].value = digit; });
        otpInputs[Math.min(pasted.length, 5)].focus();
      });
    });
    loginOtpForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const otpDigits = otpInputs.map((input) => input.value).join("");
      if (otpDigits.length !== 4) {
        otpError.textContent = "Enter all four OTP digits to continue.";
        otpInputs.find((input) => !input.value)?.focus();
        return;
      }
      if (otpVerifiedInWidget) return;
      if (typeof window.verifyOtp !== "function") {
        setSdkUnavailableMessage(otpError);
        return;
      }

      otpError.textContent = "";
      loginVerifyButton.disabled = true;
      loginVerifyButton.textContent = "Verifying OTP…";
      let callbackHandled = false;
      const onVerified = async (data) => {
        if (callbackHandled) return;
        callbackHandled = true;
        window.clearInterval(otpCountdownTimer);
        if (resendOtpButton) resendOtpButton.disabled = true;
        if (!data || data.type !== "success" || typeof data.message !== "string" || !data.message) {
          loginVerifyButton.disabled = false;
          loginVerifyButton.textContent = "Verify OTP";
          showErrorPopup("otpVerify");
          return;
        }
        try {
          const response = await fetch("/api/auth/msg91", {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ accessToken: data.message, mobileNumber: otpIdentifier })
          });
          let result = null;
          try { result = await response.json(); } catch (_) {}
          if (!response.ok || !result || !result.success || !result.playerId) {
            const signInError = new Error("sign-in rejected");
            signInError.status = response.status;
            throw signInError;
          }
          otpVerifiedInWidget = true;
          isAuthenticated = true;
          playerId = result.playerId;
          loginScreen.hidden = true;
          document.body.classList.add("is-authenticated");
          loginVerifyButton.textContent = "Verified";
          otpError.textContent = "";
          otpPreviewNote.hidden = true;
          updateDisplayNameUI(playerDisplayName);
          trackEvent("page_visit", { path: window.location.pathname });
          if (isNewSession) trackEvent("session_start");
          const restored = restoreSavedClaimIfActive() || restoreSavedGameOverIfActive() || restoreSavedPlayingGameIfActive();
          if (!restored) switchView(viewIntro, "intro");
        } catch (error) {
          loginVerifyButton.disabled = false;
          loginVerifyButton.textContent = "Verify OTP";
          if (!error || !error.status) {
            showErrorPopup("network", { key: "signin-network" });
          } else if (error.status === 401) {
            showErrorPopup("otpVerify");
          } else if (error.status === 503 || error.status >= 500) {
            showErrorPopup("signIn", { icon: "server", message: "Phone sign-in is temporarily unavailable. Please try again in a few minutes." });
          } else {
            showErrorPopup("signIn");
          }
        }
      };
      const onVerifyFailed = (error) => {
        if (callbackHandled) return;
        callbackHandled = true;
        loginVerifyButton.disabled = false;
        loginVerifyButton.textContent = "Verify OTP";
        showOtpError("verify", error);
      };
      try {
        // Keep the OTP as a string so a leading zero is preserved.
        window.verifyOtp(otpDigits, onVerified, onVerifyFailed);
      } catch (error) {
        onVerifyFailed(error);
      }
    });
    document.getElementById("edit-mobile-btn").addEventListener("click", () => {
      window.clearInterval(otpCountdownTimer);
      otpIdentifier = "";
      otpVerifiedInWidget = false;
      loginOtpForm.hidden = true;
      otpPreviewNote.hidden = true;
      loginPhoneForm.hidden = false;
      loginVerifyButton.disabled = false;
      loginVerifyButton.textContent = "Verify OTP";
      if (resendOtpButton) resendOtpButton.disabled = true;
      otpError.textContent = "";
      otpInputs.forEach((input) => { input.value = ""; });
      loginMobileInput.focus();
    });
    resendOtpButton.addEventListener("click", (event) => {
      event.preventDefault();
      otpError.textContent = "";
      if (typeof window.retryOtp !== "function") {
        setSdkUnavailableMessage(otpError);
        return;
      }
      resendOtpButton.disabled = true;
      resendOtpButton.textContent = "Resending…";
      let callbackHandled = false;
      const finishResend = () => {
        if (callbackHandled) return;
        callbackHandled = true;
        resendOtpButton.textContent = "Resend OTP";
        startOtpCountdown();
      };
      const onResent = () => {
        finishResend();
        otpInputs.forEach((input) => { input.value = ""; });
        otpInputs[0].focus();
      };
      const onResendFailed = (error) => {
        finishResend();
        showOtpError("resend", error);
      };
      try {
        // MSG91 documents null as the retry channel for its default channel setup.
        window.retryOtp(null, onResent, onResendFailed);
      } catch (error) {
        onResendFailed(error);
      }
    });
  }

  // Full-Screen Confetti Celebration Overlay
  const fullscreenConfettiOverlay = document.getElementById("fullscreen-confetti-overlay");

  // Leaderboard & Player Identity Elements
  const leaderboardModal = document.getElementById("leaderboard-modal");
  const openLeaderboardBtn = document.getElementById("open-leaderboard-btn");
  const resultLeaderboardBtn = document.getElementById("result-leaderboard-btn");
  const closeLeaderboardBtn = document.getElementById("close-leaderboard-btn");
  const doneLeaderboardBtn = document.getElementById("done-leaderboard-btn");
  const playerNameInput = document.getElementById("player-name-input");
  const saveNameBtn = document.getElementById("save-name-btn");
  const playerNameFeedback = document.getElementById("player-name-feedback");
  const playerChipName = document.getElementById("player-chip-display-name");
  const playerChipEditBtn = document.getElementById("player-chip-edit-btn");
  const playerLogoutBtn = document.getElementById("player-logout-btn");
  const playerNavName = document.getElementById("player-nav-name");
  const playerNavHome = document.getElementById("player-nav-home");
  const introFallingFood = document.getElementById("intro-falling-food");

  let isSavingPlayerName = false;
  let playerNameFeedbackTimer = null;

  // =========================================================================
  // ANONYMOUS FIRST-PARTY PLAYER IDENTIFICATION (Zero invasive fingerprinting)
  // =========================================================================
  function getOrCreateUUID(storage, key) {
    try {
      let val = storage.getItem(key);
      if (!val) {
        if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
          val = crypto.randomUUID();
        } else {
          val = "uuid-" + Date.now().toString(36) + "-" + Math.random().toString(36).substring(2, 10);
        }
        storage.setItem(key, val);
      }
      return val;
    } catch (_) {
      return "anon-" + Date.now().toString(36);
    }
  }

  let playerId = "";
  let isNewSession = false;
  let sessionId = "";
  try {
    sessionId = sessionStorage.getItem("soofi_mandi_session_id");
    if (!sessionId) {
      sessionId = getOrCreateUUID(sessionStorage, "soofi_mandi_session_id");
      isNewSession = true;
    }
  } catch (_) {
    sessionId = "sess-" + Date.now().toString(36);
  }

  function getStoredDisplayName() {
    try {
      let name = localStorage.getItem("soofi_mandi_display_name");
      if (!name) {
        const suffix = Math.floor(1000 + Math.random() * 9000);
        name = `MandiGuest_${suffix}`;
        localStorage.setItem("soofi_mandi_display_name", name);
      }
      return name;
    } catch (_) {
      return "MandiGuest";
    }
  }

  let playerDisplayName = getStoredDisplayName();
  let playerPersonalBest = 0;
  try {
    playerPersonalBest = parseInt(localStorage.getItem("soofi_mandi_pb") || "0", 10) || 0;
  } catch (_) {}

  // =========================================================================
  // PRIVACY-CONSCIOUS WEBSITE ACTIVITY TRACKING
  // =========================================================================
  function trackEvent(eventName, metadata = {}) {
    try {
      if (!isAuthenticated || !playerId) return;
      const payload = {
        sessionId,
        eventName,
        metadata: metadata || {}
      };

      if (eventName === "game_abandon" && typeof navigator !== "undefined" && navigator.sendBeacon) {
        const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
        navigator.sendBeacon("/api/analytics/events", blob);
        return;
      }

      fetch("/api/analytics/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      }).catch(() => {
        // Resilient: gracefully ignore offline/network errors
      });
    } catch (_) {}
  }

  // =========================================================================
  // GLOBAL LEADERBOARD INTEGRATION (Top 10 + Deterministic Tie-breaking)
  // =========================================================================
  function formatTimeAgo(isoString) {
    try {
      const diffSec = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
      if (isNaN(diffSec) || diffSec < 0) return "just now";
      if (diffSec < 60) return "just now";
      if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
      if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
      return `${Math.floor(diffSec / 86400)}d ago`;
    } catch (_) {
      return "recently";
    }
  }

  async function fetchLeaderboard() {
    const tbody = document.getElementById("leaderboard-tbody");
    const pbEl = document.getElementById("modal-pb-score");
    if (pbEl) pbEl.textContent = String(playerPersonalBest);

    if (tbody) {
      tbody.innerHTML = '<tr><td colspan="4" class="leaderboard-loading">Loading top scores...</td></tr>';
    }

    try {
      const res = await fetch("/api/leaderboard");
      if (!res.ok) throw new Error("Leaderboard fetch failed");
      const data = await res.json();
      if (!data.success || !Array.isArray(data.leaderboard)) {
        throw new Error("Invalid leaderboard data");
      }

      if (!tbody) return;

      if (data.leaderboard.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" class="leaderboard-empty">No feast records yet. Be the first!</td></tr>';
        return;
      }

      let rowsHtml = "";
      data.leaderboard.forEach((entry, idx) => {
        const rank = idx + 1;
        let rankDisplay = `#${rank}`;
        if (rank === 1) rankDisplay = '<span class="rank-badge-top1">🥇 1</span>';
        else if (rank === 2) rankDisplay = '<span class="rank-badge-top2">🥈 2</span>';
        else if (rank === 3) rankDisplay = '<span class="rank-badge-top3">🥉 3</span>';

        const isMe = entry.player_id === playerId;
        const rowClass = isMe ? ' class="is-current-player"' : "";
        const safeName = (entry.display_name || "Guest").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        const timeAgo = formatTimeAgo(entry.submitted_at);

        rowsHtml += `
          <tr${rowClass}>
            <td class="td-rank">${rankDisplay}</td>
            <td class="td-player">${safeName}${isMe ? " (You)" : ""}</td>
            <td class="td-score">${entry.score} pts</td>
            <td class="td-date">${timeAgo}</td>
          </tr>
        `;
      });

      tbody.innerHTML = rowsHtml;
    } catch (err) {
      if (leaderboardModal && leaderboardModal.classList.contains("is-open")) {
        const offline = window.SoofiPopup && window.SoofiPopup.isNetworkError(err);
        showErrorPopup(offline ? "network" : "server", {
          key: "leaderboard-load",
          title: "Leaderboard unavailable",
          message: offline
            ? "We couldn't load the top scores. Check your connection and try again."
            : "We couldn't load the top scores right now. Please try again in a moment.",
          actions: [
            { label: "Close", value: "close" },
            { label: "Try again", value: "retry", primary: true, onClick: () => fetchLeaderboard() }
          ]
        });
      }
      if (tbody) {
        tbody.innerHTML = '<tr><td colspan="4" class="leaderboard-empty">Leaderboard unavailable right now.</td></tr>';
      }
    }
  }

  // Obtain the server-issued game-session nonce for this round. Reuses the one requested at game
  // start; only if that request failed (e.g. network) is a single new nonce requested, so a retry
  // never consumes more than one session for the round.
  async function ensureRoundGameSession() {
    let sessionId = currentGameSessionPromise ? await currentGameSessionPromise : null;
    if (sessionId) return sessionId;
    try {
      const res = await fetch("/api/game/start", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: "{}"
      });
      const data = res.ok ? await res.json() : null;
      sessionId = data && data.success ? data.gameSessionId : null;
    } catch (_) {
      sessionId = null;
    }
    if (sessionId) {
      currentGameSessionId = sessionId;
      currentGameSessionPromise = Promise.resolve(sessionId);
    }
    return sessionId;
  }

  // Sends the round's score for server verification. Returns
  //   { ok: true, data }            on success (data.verifiedScore is authoritative), or
  //   { ok: false, message }        on failure, or
  //   { ok: false, stale: true }    when a newer round started meanwhile.
  // The server treats a resend for an already-consumed session as idempotent and returns the
  // stored verified result, so retries never create duplicate scores.
  async function submitScore(payload) {
    const isStale = () => payload.roundId !== undefined && payload.roundId !== currentRoundId;
    if (!payload.gameSessionId) {
      payload.gameSessionId = await ensureRoundGameSession();
      if (isStale()) return { ok: false, stale: true };
      if (!payload.gameSessionId) {
        return { ok: false, kind: "network", message: "We couldn't reach the server to verify your score. Check your connection and retry." };
      }
      // Save the session id now so a refresh mid-request resends with the SAME session.
      persistGameOverState(false);
    }

    const body = JSON.stringify({
      displayName: playerDisplayName,
      score: payload.score,
      foodCaught: payload.foodCaught,
      missedCount: payload.missedCount,
      durationSeconds: payload.durationSeconds,
      events: payload.events || [],
      isDevTest: Boolean(payload.isDevTest),
      gameSessionId: payload.gameSessionId
    });

    for (let attempt = 0; attempt < 2; attempt++) {
      let res;
      try {
        res = await fetch("/api/leaderboard", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body
        });
      } catch (_) {
        return { ok: false, kind: "network", message: "Network error while verifying your score. Check your connection and retry." };
      }
      if (isStale()) return { ok: false, stale: true };

      let data = null;
      try { data = await res.json(); } catch (_) {}

      if (res.ok && data && data.success && Number.isFinite(Number(data.verifiedScore))) {
        return { ok: true, data };
      }
      if (res.status === 429 && attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 1000)); // brief server rate limit
        if (isStale()) return { ok: false, stale: true };
        continue;
      }
      if (res.status === 401) {
        return { ok: false, kind: "session", message: "Your sign-in has expired. Please sign in again to verify your score." };
      }
      if (res.status === 400) {
        return { ok: false, kind: "rejected", message: "Your score could not be verified by the server." };
      }
      return { ok: false, kind: res.status === 403 ? "rejected" : "server", message: "Score verification failed. Please retry." };
    }
    return { ok: false, kind: "server", message: "Score verification failed. Please retry." };
  }

  // Shows the result for a server-verified score: unlock (>= 100) or locked (< 100).
  function applyVerifiedResult(verifiedScore) {
    if (rewardCard) rewardCard.classList.remove("is-score-pending");
    if (scoreVerifyStatus) scoreVerifyStatus.classList.remove("is-failed");
    if (rewardScoreNumber) rewardScoreNumber.textContent = String(verifiedScore);
    if (unlockScoreVal) unlockScoreVal.textContent = String(verifiedScore);
    if (unlockOfferError) {
      unlockOfferError.textContent = "";
      unlockOfferError.style.display = "none";
    }

    if (verifiedScore >= 100) {
      if (rewardCard) {
        rewardCard.classList.remove("is-loss");
        rewardCard.classList.add("is-offer-unlocked");
      }
      if (rewardScoreSummary) rewardScoreSummary.textContent = "Congratulations! You've unlocked a reward.";
      if (unlockOfferBtn) {
        unlockOfferBtn.disabled = false;
        unlockOfferBtn.removeAttribute("aria-disabled");
        unlockOfferBtn.style.display = "";
      }
      if (rewardLockedWrap) rewardLockedWrap.style.display = "none";
      if (rewardUnlockBanner) rewardUnlockBanner.style.display = "flex";
      if (rewardOfferCard) rewardOfferCard.style.display = "none";
      if (rewardLossHeadline) rewardLossHeadline.style.display = "none";
    } else {
      if (rewardCard) {
        rewardCard.classList.remove("is-offer-unlocked");
        rewardCard.classList.add("is-loss");
      }
      if (rewardLossHeadline) rewardLossHeadline.style.display = "none";
      if (rewardScoreSummary) rewardScoreSummary.textContent = "Reach 100 points to unlock your reward!";
      if (rewardLockedWrap) rewardLockedWrap.style.display = "flex";
      if (offerLockedBtn) {
        offerLockedBtn.disabled = true;
        offerLockedBtn.setAttribute("aria-disabled", "true");
        offerLockedBtn.style.display = "";
      }
      if (rewardUnlockBanner) rewardUnlockBanner.style.display = "none";
      if (rewardOfferCard) rewardOfferCard.style.display = "none";
    }
  }

  // Pending / failed verification: hide every offer control until the server confirms the score.
  function showScoreVerificationState(state, message) {
    if (rewardCard) {
      rewardCard.classList.remove("is-loss", "is-offer-unlocked");
      rewardCard.classList.add("is-score-pending");
    }
    if (unlockOfferBtn) unlockOfferBtn.disabled = true;
    if (rewardUnlockBanner) rewardUnlockBanner.style.display = "none";
    if (rewardLockedWrap) rewardLockedWrap.style.display = "none";
    const failed = state === "failed";
    if (scoreVerifyStatus) scoreVerifyStatus.classList.toggle("is-failed", failed);
    if (scoreVerifyText) scoreVerifyText.textContent = failed ? message : "Verifying your score…";
    if (scoreVerifyRetry) {
      scoreVerifyRetry.hidden = !failed;
      scoreVerifyRetry.disabled = false;
    }
    if (rewardScoreSummary) {
      rewardScoreSummary.textContent = failed ? "Score not verified yet." : "Checking your score with our server…";
    }
  }

  // Runs (or re-runs) server verification for the finished round. Only one request is in flight
  // at a time; retries resend the identical payload with the same gameSessionId.
  function verifyRoundScore() {
    if (scoreVerification.status === "pending" && pendingScoreSubmission) return pendingScoreSubmission;
    const payload = scoreVerification.payload;
    if (!payload) return Promise.resolve(null);
    scoreVerification.status = "pending";
    showScoreVerificationState("pending");
    persistGameOverState(true);

    pendingScoreSubmission = submitScore(payload).then((result) => {
      // Ignore results for a round that was replaced (new game) or reset meanwhile.
      if (result.stale || payload.roundId !== currentRoundId || scoreVerification.payload !== payload) return null;
      if (!result.ok) {
        scoreVerification.status = "failed";
        showScoreVerificationState("failed", result.message);
        persistGameOverState(true);
        showScoreVerificationPopup(result.kind);
        return null;
      }
      const data = result.data;
      const verifiedScore = Number(data.verifiedScore);
      scoreVerification.status = "verified";
      scoreVerification.verifiedScore = verifiedScore;
      scoreVerification.gameSessionId = data.gameSessionId || payload.gameSessionId;
      currentGameSessionId = scoreVerification.gameSessionId;
      score = verifiedScore;
      if (verifiedScore > playerPersonalBest) {
        playerPersonalBest = verifiedScore;
        try { localStorage.setItem("soofi_mandi_pb", String(playerPersonalBest)); } catch (_) {}
        const pbEl = document.getElementById("modal-pb-score");
        if (pbEl) pbEl.textContent = String(playerPersonalBest);
      }
      persistGameOverState(true);
      applyVerifiedResult(verifiedScore);
      return data;
    });
    return pendingScoreSubmission;
  }

  // Popup for a failed verification. The result card keeps its own Retry button, so the
  // customer can still retry after closing the popup.
  function showScoreVerificationPopup(kind) {
    const retryActions = [
      { label: "Close", value: "close" },
      { label: "Retry", value: "retry", primary: true, onClick: () => { if (scoreVerification.status === "failed") verifyRoundScore(); } }
    ];
    if (kind === "network") {
      showErrorPopup("network", { key: "score-verify", message: "We couldn't reach our server to verify your score. Check your connection and retry.", actions: retryActions });
    } else if (kind === "session") {
      showErrorPopup("session", { key: "score-verify", message: "Your sign-in has expired. Please sign in again to verify your score." });
    } else if (kind === "rejected") {
      showErrorPopup("scoreVerify", { key: "score-verify", title: "Score couldn't be verified", message: "We couldn't confirm this round's score. Please play a new round." });
    } else {
      showErrorPopup("scoreVerify", { key: "score-verify", actions: retryActions });
    }
  }

  if (scoreVerifyRetry) {
    scoreVerifyRetry.addEventListener("click", () => {
      if (scoreVerification.status !== "failed") return;
      scoreVerifyRetry.disabled = true;
      verifyRoundScore();
    });
  }

  function updateDisplayNameUI(name) {
    if (playerChipName) playerChipName.textContent = name;
    if (playerNavName) playerNavName.textContent = name;
    if (playerNameInput) playerNameInput.value = name;
  }

  function openLeaderboard() {
    if (!leaderboardModal) return;
    leaderboardModal.classList.add("is-open");
    leaderboardModal.setAttribute("aria-hidden", "false");
    clearPlayerNameFeedback();
    updateDisplayNameUI(playerDisplayName);
    fetchLeaderboard();
    trackEvent("leaderboard_view");
  }

  function closeLeaderboard() {
    if (!leaderboardModal) return;
    leaderboardModal.classList.remove("is-open");
    leaderboardModal.setAttribute("aria-hidden", "true");
    clearPlayerNameFeedback();
  }

  function showPlayerNameFeedback(message, type = "success") {
    if (!playerNameFeedback) return;
    if (playerNameFeedbackTimer) {
      clearTimeout(playerNameFeedbackTimer);
      playerNameFeedbackTimer = null;
    }
    playerNameFeedback.textContent = message;
    playerNameFeedback.className = `player-name-feedback is-visible is-${type}`;
    if (type === "success") {
      playerNameFeedbackTimer = setTimeout(() => {
        if (playerNameFeedback) {
          playerNameFeedback.classList.remove("is-visible");
        }
      }, 4000);
    }
  }

  function clearPlayerNameFeedback() {
    if (playerNameFeedbackTimer) {
      clearTimeout(playerNameFeedbackTimer);
      playerNameFeedbackTimer = null;
    }
    if (playerNameFeedback) {
      playerNameFeedback.className = "player-name-feedback";
      playerNameFeedback.textContent = "";
    }
  }

  async function savePlayerName() {
    if (!playerNameInput || isSavingPlayerName) return;

    const raw = playerNameInput.value.trim();
    if (!raw) {
      showPlayerNameFeedback("Couldn't save your name. Please try again.", "error");
      if (playerNameInput) playerNameInput.focus();
      return;
    }

    const sanitized = raw.replace(/<[^>]*>?/gm, "").substring(0, 20).trim();
    if (!sanitized) {
      showPlayerNameFeedback("Couldn't save your name. Please try again.", "error");
      if (playerNameInput) playerNameInput.focus();
      return;
    }

    isSavingPlayerName = true;
    clearPlayerNameFeedback();

    if (saveNameBtn) {
      saveNameBtn.disabled = true;
      saveNameBtn.setAttribute("aria-disabled", "true");
      saveNameBtn.classList.add("is-saving");
      saveNameBtn.textContent = "SAVING...";
    }

    try {
      const response = await fetch("/api/player/name", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: sanitized
        })
      });

      if (response.ok) {
        const data = await response.json();
        if (data.success) {
          const confirmedName = data.displayName || sanitized;
          playerDisplayName = confirmedName;
          try {
            localStorage.setItem("soofi_mandi_display_name", confirmedName);
          } catch (_) {}
          updateDisplayNameUI(confirmedName);

          // Confirmed success from backend database operation
          showPlayerNameFeedback("Name saved successfully!", "success");

          // Refresh leaderboard to immediately reflect the new name in ranks
          fetchLeaderboard();
        } else {
          showErrorPopup("generic", { key: "name-save", title: "Couldn't save your name", message: "Please check the name and try again." });
        }
      } else if (response.status === 401) {
        showErrorPopup("session", { key: "name-save-session" });
      } else if (response.status === 400) {
        showErrorPopup("generic", { key: "name-save", title: "Couldn't save your name", message: "Please use 2–20 letters or numbers and try again." });
      } else {
        showErrorPopup("server", { key: "name-save", title: "Couldn't save your name", message: "Our server had a hiccup. Please try saving again in a moment." });
      }
    } catch (_) {
      // Network failure, server down, or offline
      showErrorPopup("network", { key: "name-save-network", message: "We couldn't save your name. Check your connection and try again." });
    } finally {
      isSavingPlayerName = false;
      if (saveNameBtn) {
        saveNameBtn.disabled = false;
        saveNameBtn.removeAttribute("aria-disabled");
        saveNameBtn.classList.remove("is-saving");
        saveNameBtn.textContent = "SAVE";
      }
    }
  }

  // Demo Offers Configuration
  const demoOffers = window.SOOFI_MANDI_DEMO_OFFERS || window.SOOfiMandiOffers || [];
  let currentOffer = null;

  // =========================================================================
  // ZERO-DEPENDENCY WEB AUDIO API SYNTHESIZER
  // Gentle arcade sound effects (zero external files, offline-ready)
  // =========================================================================
  let audioCtx = null;
  function getAudioContext() {
    try {
      if (!audioCtx && (typeof window !== "undefined") && (window.AudioContext || window.webkitAudioContext)) {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        audioCtx = new AudioContextClass();
      }
      if (audioCtx && audioCtx.state === "suspended") {
        audioCtx.resume().catch(() => {});
      }
      return audioCtx;
    } catch (_) {
      return null;
    }
  }

  if (typeof window !== "undefined") {
    ["pointerdown", "touchstart", "keydown"].forEach((evt) => {
      window.addEventListener(evt, () => getAudioContext(), { once: true, passive: true });
    });
  }

  const Sound = {
    normalCatch() {
      try {
        const ctx = getAudioContext();
        if (!ctx) return;
        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(587.33, now); // D5
        osc.frequency.exponentialRampToValueAtTime(880, now + 0.11); // A5
        gain.gain.setValueAtTime(0.14, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.14);
      } catch (_) {}
    },
    goldenMandiCatch() {
      try {
        const ctx = getAudioContext();
        if (!ctx) return;
        const now = ctx.currentTime;
        [659.25, 880, 1174.66].forEach((freq, idx) => { // E5, A5, D6 shimmer arpeggio
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = "triangle";
          const t = now + idx * 0.055;
          osc.frequency.setValueAtTime(freq, t);
          osc.frequency.exponentialRampToValueAtTime(freq * 1.25, t + 0.18);
          gain.gain.setValueAtTime(0.18, t);
          gain.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(t);
          osc.stop(t + 0.22);
        });
      } catch (_) {}
    },
    bombHit() {
      try {
        const ctx = getAudioContext();
        if (!ctx) return;
        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sawtooth";
        osc.frequency.setValueAtTime(140, now);
        osc.frequency.exponentialRampToValueAtTime(45, now + 0.26);
        gain.gain.setValueAtTime(0.2, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.28);
      } catch (_) {}
    },
    comboActivation() {
      try {
        const ctx = getAudioContext();
        if (!ctx) return;
        const now = ctx.currentTime;
        [523.25, 659.25, 783.99, 1046.5].forEach((freq, idx) => { // C5, E5, G5, C6 fanfare
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = "sine";
          const t = now + idx * 0.045;
          osc.frequency.setValueAtTime(freq, t);
          gain.gain.setValueAtTime(0.15, t);
          gain.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(t);
          osc.stop(t + 0.22);
        });
      } catch (_) {}
    },
    missWarning() {
      try {
        const ctx = getAudioContext();
        if (!ctx) return;
        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(440, now);
        osc.frequency.setValueAtTime(370, now + 0.1);
        gain.gain.setValueAtTime(0.12, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.24);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.24);
      } catch (_) {}
    },
    gameOver() {
      try {
        const ctx = getAudioContext();
        if (!ctx) return;
        const now = ctx.currentTime;
        [440, 392, 349.23, 293.66].forEach((freq, idx) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = "sine";
          const t = now + idx * 0.09;
          osc.frequency.setValueAtTime(freq, t);
          gain.gain.setValueAtTime(0.13, t);
          gain.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(t);
          osc.stop(t + 0.28);
        });
      } catch (_) {}
    }
  };

  // =========================================================================
  // FEATURE TOGGLES & GAME CONFIGURATION (Modular & Independently Controllable)
  // =========================================================================
  const DEFAULT_GAME_FEATURES = {
    goldenMandi: true,
    comboCatch: true,
    floatingScores: true,
    bomb: true
  };

  const DEFAULT_GAME_CONFIG = {
    normalFoodPoints: 1,
    goldenMandiPoints: 3,
    bombPoints: -10,
    goldenMandiSpawnChance: 0.015,
    bombSpawnChance: 0.025,
    comboActivationCount: 5,
    comboMultiplier: 2,
    missLimit: 5,
    offerEligibilityScore: 100,
    minSpawnInterval: 0.45,
    maxSpawnInterval: 0.70,
    minFallSpeedDesktop: 175,
    maxFallSpeedDesktop: 235,
    minFallSpeedMobile: 150,
    maxFallSpeedMobile: 200,
    maxConcurrentFoodDesktop: 7,
    maxConcurrentFoodMobile: 5
  };

  let GAME_FEATURES = Object.assign({}, DEFAULT_GAME_FEATURES, (typeof window !== "undefined" && window.GAME_FEATURES) || {});
  let GAME_CONFIG = Object.assign({}, DEFAULT_GAME_CONFIG, (typeof window !== "undefined" && window.GAME_CONFIG) || {});

  /**
   * Exactly 3 types of authentic falling mandi delicacies:
   * 1. Chicken Mandi — chicken-mandi.png
   * 2. Beef Mandi — beef-mandi.png
   * 3. Mutton Mandi — mutton-mandi.png
   */
  const FOOD_TYPES = [
    {
      id: "chicken-mandi",
      name: "Chicken Mandi",
      image: "assets/chicken-mandi.png"
    },
    {
      id: "beef-mandi",
      name: "Beef Mandi",
      image: "assets/beef-mandi.png"
    },
    {
      id: "mutton-mandi",
      name: "Mutton Mandi",
      image: "assets/mutton-mandi.png"
    }
  ];

  // Game Runtime State
  let gameState = "intro"; // "intro" | "playing" | "results" | "revealed"
  let roundStartTime = 0;
  const MAX_MISSES = 5;
  let score = 0;
  let missedCount = 0;
  let gameAnimId = null;
  let lastFrameTime = 0;
  let spawnCooldown = 0;
  let lastSpawnX = -999;
  let fallingItems = [];
  let confettiCleanupTimer = null;
  let offerTransitionTimer = null;

  // Dynamic Enhanced Gameplay State
  let consecutiveCatches = 0;
  let foodCaughtCount = 0;
  let itemsSpawnedTotal = 0;
  let roundEvents = [];
  let isDevTestRound = false;
  let isGamePaused = false;
  let pauseStartTime = 0;

  // Scoring calculation helper
  function getCatchScoring(itemType) {
    if (typeof window !== "undefined" && typeof window.calculateCatchPoints === "function") {
      return window.calculateCatchPoints(itemType, consecutiveCatches, GAME_FEATURES, GAME_CONFIG);
    }
    const allDisabled = !GAME_FEATURES.goldenMandi && !GAME_FEATURES.comboCatch && !GAME_FEATURES.floatingScores && !GAME_FEATURES.bomb;
    if (allDisabled) {
      if (itemType === "bomb") {
        return { awardedPoints: 0, basePoints: 0, comboMultiplier: 1, isBomb: true };
      }
      return { awardedPoints: 1, basePoints: 1, comboMultiplier: 1, isBomb: false };
    }
    if (itemType === "bomb") {
      const penalty = GAME_FEATURES.bomb ? (GAME_CONFIG.bombPoints || -10) : 0;
      return { awardedPoints: penalty, basePoints: penalty, comboMultiplier: 1, isBomb: true };
    }
    let comboMultiplier = 1;
    if (GAME_FEATURES.comboCatch && consecutiveCatches >= (GAME_CONFIG.comboActivationCount || 5)) {
      comboMultiplier = GAME_CONFIG.comboMultiplier || 2;
    }
    const base = (itemType === "golden-mandi" && GAME_FEATURES.goldenMandi)
      ? (GAME_CONFIG.goldenMandiPoints || 3)
      : (GAME_CONFIG.normalFoodPoints || 1);
    return { awardedPoints: base * comboMultiplier, basePoints: base, comboMultiplier, isBomb: false };
  }

  // Update HUD Enhancement Indicators (Combo x2 Only)
  function updateEnhancementsHUD(justBumpedCombo = false) {
    const isComboActive = Boolean(GAME_FEATURES.comboCatch && consecutiveCatches >= (GAME_CONFIG.comboActivationCount || 5));

    if (hudEnhancementsStrip) {
      hudEnhancementsStrip.style.display = isComboActive ? "flex" : "none";
    }

    if (hudComboEl && hudComboValEl) {
      if (isComboActive) {
        hudComboEl.style.display = "inline-flex";
        hudComboValEl.textContent = `x${GAME_CONFIG.comboMultiplier || 2}`;

        if (justBumpedCombo) {
          hudComboEl.classList.remove("is-bumped");
          void hudComboEl.offsetWidth;
          hudComboEl.classList.add("is-bumped");
        }
      } else {
        hudComboEl.style.display = "none";
      }
    }
  }

  // Floating Popup Animation Helper (smooth upward movement, auto-removed from DOM)
  function spawnFloatingPopup(text, className = "is-floating-score", x = 0, y = 0, duration = 650) {
    if (!GAME_FEATURES.floatingScores || !gamePlayArea) return;
    const popup = document.createElement("div");
    popup.className = `catch-popup ${className}`;
    popup.textContent = text;
    popup.style.left = `${x}px`;
    popup.style.top = `${y}px`;
    gamePlayArea.appendChild(popup);
    setTimeout(() => {
      if (popup.parentNode) popup.remove();
    }, duration);
  }

  // Bucket Physics & Interaction State
  let bucketX = 0; // Horizontal center of bucket relative to play area
  let isDraggingBucket = false;
  let dragOffsetX = 0;
  let hasMovedBucket = false;
  let activePointerId = null;
  let cachedPlayAreaRect = null;

  function updatePlayAreaRect() {
    if (gamePlayArea) {
      cachedPlayAreaRect = gamePlayArea.getBoundingClientRect();
    }
  }

  // Device-specific element dimensions scaled to the enlarged playfield
  function getPlayfieldMetrics() {
    const width = window.innerWidth;
    const isMobile = width < 600;
    const isTablet = width >= 600 && width < 900;

    let bucketWidth = 130;
    let bucketHeight = 130;
    let imageWidth = 82;
    let imageHeight = 64;
    let labelHeight = 22;

    if (isMobile) {
      bucketWidth = 90;
      bucketHeight = 90;
      imageWidth = 60;
      imageHeight = 48;
      labelHeight = 18;
    } else if (isTablet) {
      bucketWidth = 110;
      bucketHeight = 110;
      imageWidth = 72;
      imageHeight = 56;
      labelHeight = 20;
    }

    const containerWidth = Math.max(imageWidth, 90);
    const containerHeight = imageHeight + labelHeight + 4;

    return {
      isMobile,
      isTablet,
      bucketWidth,
      bucketHeight,
      imageWidth,
      imageHeight,
      containerWidth,
      containerHeight
    };
  }

  // Populate active offer details
  function applyOfferContent() {
    currentOffer = (demoOffers && demoOffers[0]) || {
      badge: "YOUR FEAST REWARD",
      title: "Complimentary Yemeni Delicacy",
      description: "Enjoy a special feast reward with your dine-in experience.",
      instructions: "Show this screen to our staff to claim your reward."
    };

    const offerBadgeEl = document.getElementById("offer-badge");
    if (offerBadgeEl) {
      if (currentOffer.badge) offerBadgeEl.textContent = currentOffer.badge;
      offerBadgeEl.style.display = "none";
    }
    if (offerTitle && currentOffer.title) {
      offerTitle.textContent = currentOffer.title;
    }
    if (offerDescription && currentOffer.description) {
      offerDescription.textContent = currentOffer.description;
    }
  }
  applyOfferContent();

  // Switch between clean game views and update container layout class
  function switchView(targetView, stateName) {
    const allViews = [viewIntro, viewPlaying, viewResults];
    allViews.forEach((v) => {
      if (v) {
        v.classList.remove("is-active");
        v.setAttribute("aria-hidden", "true");
      }
    });

    if (targetView) {
      targetView.classList.add("is-active");
      targetView.setAttribute("aria-hidden", "false");
    }

    document.body.classList.remove("state-intro", "state-playing", "state-results", "state-revealed");
    document.body.classList.add(`state-${stateName}`);

    const pageWrap = document.querySelector(".page-wrap");
    if (pageWrap) {
      pageWrap.classList.remove("is-intro", "is-playing", "is-results", "is-revealed");
      pageWrap.classList.add(`is-${stateName}`);
    }

    if (container && stateName) {
      container.classList.remove("is-intro", "is-playing", "is-results", "is-revealed");
      container.classList.add(`is-${stateName}`);
    }

    const brandHeader = document.querySelector(".brand-header");
    if (brandHeader) {
      brandHeader.style.display = (stateName === "playing") ? "flex" : "none";
    }

    const resetWrap = document.querySelector(".reset-wrap");
    if (resetWrap) {
      resetWrap.style.display = "none";
    }
  }

  // Position Player Bucket Horizontally (Both rear & front layers synchronized)
  function setBucketPosition(clientX, offset = 0) {
    if (!gamePlayArea || !bucketFront) return;
    if (!cachedPlayAreaRect) updatePlayAreaRect();
    const rect = cachedPlayAreaRect;
    if (!rect || rect.width <= 0) return;

    const metrics = getPlayfieldMetrics();
    const halfWidth = metrics.bucketWidth / 2;
    const minX = halfWidth + 6;
    const maxX = rect.width - halfWidth - 6;

    // Smooth edge compensation:
    // Blend offset towards 0 as finger approaches either wall so the bucket
    // can smoothly reach 100% of both left and right edges without sticking.
    let effectiveOffset = offset;
    const touchXInArea = clientX - rect.left;
    const edgeMargin = halfWidth * 1.5;
    if (touchXInArea < edgeMargin) {
      effectiveOffset = offset * Math.max(0, touchXInArea / edgeMargin);
    } else if (touchXInArea > rect.width - edgeMargin) {
      effectiveOffset = offset * Math.max(0, (rect.width - touchXInArea) / edgeMargin);
    }

    const rawX = touchXInArea - effectiveOffset;
    const newX = Math.max(minX, Math.min(maxX, rawX));

    // Slight dynamic tilt in movement direction for feedback
    const dx = newX - bucketX;
    const isLeft = dx < -2;
    const isRight = dx > 2;

    [bucketRear, bucketFront].forEach((b) => {
      if (!b) return;
      if (isRight) {
        b.classList.remove("is-moving-left");
        b.classList.add("is-moving-right");
      } else if (isLeft) {
        b.classList.remove("is-moving-right");
        b.classList.add("is-moving-left");
      } else {
        b.classList.remove("is-moving-left", "is-moving-right");
      }
      b.style.left = `${newX}px`;
    });

    bucketX = newX;

    if (!hasMovedBucket && bucketDragIndicator) {
      hasMovedBucket = true;
      bucketDragIndicator.classList.add("is-hidden");
    }
  }

  function centerBucket() {
    if (!gamePlayArea) return;
    updatePlayAreaRect();
    const rect = cachedPlayAreaRect;
    bucketX = rect && rect.width > 0 ? rect.width / 2 : 200;
    [bucketRear, bucketFront].forEach((b) => {
      if (!b) return;
      b.style.left = `${bucketX}px`;
      b.classList.remove("is-moving-left", "is-moving-right");
    });
  }

  /**
   * Create falling bomb hazard item DOM element.
   * Arcade-style dark bomb body, metallic collar, curved fuse, animated fuse spark, and warning tag.
   */
  function createBombElement(metrics) {
    const el = document.createElement("div");
    el.className = "falling-bomb-item";
    el.setAttribute("role", "img");
    el.setAttribute("aria-label", "Bomb Hazard");

    const svgWrap = document.createElement("div");
    svgWrap.className = "bomb-svg-wrap";
    svgWrap.innerHTML = `
      <svg viewBox="0 0 64 64" width="56" height="56" fill="none" aria-hidden="true">
        <defs>
          <radialGradient id="bombGrad" cx="38%" cy="38%" r="60%">
            <stop offset="0%" stop-color="#4B5563" />
            <stop offset="30%" stop-color="#1F2937" />
            <stop offset="85%" stop-color="#111827" />
            <stop offset="100%" stop-color="#030712" />
          </radialGradient>
          <radialGradient id="sparkGrad" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stop-color="#FFF" />
            <stop offset="40%" stop-color="#FFDD57" />
            <stop offset="80%" stop-color="#FF4D4F" />
            <stop offset="100%" stop-color="rgba(255, 77, 79, 0)" />
          </radialGradient>
        </defs>
        <!-- Fuse Rope -->
        <path d="M34 18 C36 12 44 14 46 8" stroke="#D97706" stroke-width="2.5" stroke-linecap="round" fill="none" />
        <!-- Spark at Fuse Tip -->
        <circle class="bomb-fuse-spark" cx="46" cy="8" r="4.5" fill="url(#sparkGrad)" />
        <!-- Bomb Neck/Collar -->
        <rect x="29" y="16" width="10" height="5" rx="1.5" fill="#374151" stroke="#4B5563" stroke-width="1" />
        <!-- Bomb Spherical Body -->
        <circle cx="34" cy="38" r="22" fill="url(#bombGrad)" stroke="#374151" stroke-width="1.5" />
        <!-- Specular Highlight Shine -->
        <ellipse cx="28" cy="28" rx="6" ry="3.5" transform="rotate(-30 28 28)" fill="#9CA3AF" opacity="0.45" />
        <!-- Danger Flame in Gold -->
        <path d="M34 32 C31 35 29 38 29 42 C29 45 31.2 47 34 47 C36.8 47 39 45 39 42 C39 38 37 35 34 32 Z" fill="#F59E0B" opacity="0.9" />
      </svg>
    `;

    const label = document.createElement("span");
    label.className = "bomb-name-tag";
    label.textContent = "BOMB -10";

    el.appendChild(svgWrap);
    el.appendChild(label);
    return el;
  }

  /**
   * Create falling food DOM element using the real PNG image + food name label beneath it.
   * Both move together as a single unified falling object.
   * Labels stay horizontal and readable without unwanted rotation.
   */
  function createFoodElement(config, metrics) {
    const el = document.createElement("div");
    const isGoldenMandi = (config.id === "golden-mandi");
    el.className = "falling-food-item" + (isGoldenMandi ? " is-golden-mandi" : "");
    el.setAttribute("role", "img");
    el.setAttribute("aria-label", config.name);

    // Food platter PNG image
    const img = document.createElement("img");
    img.src = config.image;
    img.alt = config.name;
    img.className = "food-img";

    // Food name tag placed directly beneath image
    const label = document.createElement("span");
    label.className = "food-name-tag";
    label.textContent = config.name;

    el.appendChild(img);
    el.appendChild(label);

    return el;
  }

  // Spawn a Falling Item from the top (supports normal food, golden-mandi, or bomb hazard)
  function spawnFoodItem(forceType = null) {
    if (!gamePlayArea || !fallingItemsLayer) return;
    const metrics = getPlayfieldMetrics();
    const maxAllowed = metrics.isMobile
      ? GAME_CONFIG.maxConcurrentFoodMobile
      : GAME_CONFIG.maxConcurrentFoodDesktop;

    if (!forceType && fallingItems.length >= maxAllowed) return;

    itemsSpawnedTotal++;
    const rect = gamePlayArea.getBoundingClientRect();
    const minX = 18;
    const maxX = Math.max(minX + 30, rect.width - metrics.containerWidth - 18);

    let startX = minX + Math.random() * (maxX - minX);
    if (Math.abs(startX - lastSpawnX) < metrics.containerWidth * 1.4) {
      startX = startX > rect.width / 2
        ? minX + Math.random() * (rect.width / 2 - minX - metrics.containerWidth)
        : rect.width / 2 + Math.random() * (maxX - rect.width / 2);
      startX = Math.max(minX, Math.min(maxX, startX));
    }
    lastSpawnX = startX;

    const minSpeed = metrics.isMobile ? GAME_CONFIG.minFallSpeedMobile : GAME_CONFIG.minFallSpeedDesktop;
    const maxSpeed = metrics.isMobile ? GAME_CONFIG.maxFallSpeedMobile : GAME_CONFIG.maxFallSpeedDesktop;
    const speed = minSpeed + Math.random() * (maxSpeed - minSpeed);

    // Check item type determination:
    let isBomb = false;
    let isGoldenMandi = false;

    if (forceType === "bomb") {
      isBomb = true;
    } else if (forceType === "golden-mandi") {
      isGoldenMandi = true;
    } else {
      // 1. Roll Bomb Hazard if enabled and no bomb currently falling (exactly 2.5% chance, max 1 active)
      const hasFallingBomb = fallingItems.some(i => i.isBomb);
      if (
        GAME_FEATURES.bomb &&
        !hasFallingBomb &&
        Math.random() < (GAME_CONFIG.bombSpawnChance || 0.025)
      ) {
        isBomb = true;
      }
      // 2. Roll Golden Mandi if enabled, not a bomb, and no golden mandi currently falling (exactly 1.5% chance, max 1 active)
      const hasFallingMandi = fallingItems.some(i => i.isGoldenMandi);
      if (
        !isBomb &&
        GAME_FEATURES.goldenMandi &&
        !hasFallingMandi &&
        Math.random() < (GAME_CONFIG.goldenMandiSpawnChance || 0.015)
      ) {
        isGoldenMandi = true;
      }
    }

    if (isBomb) {
      const el = createBombElement(metrics);
      const startY = -metrics.containerHeight;
      el.style.transform = `translate3d(${startX}px, ${startY}px, 0)`;
      fallingItemsLayer.appendChild(el);

      fallingItems.push({
        el,
        x: startX,
        y: startY,
        imageHeight: 56,
        containerWidth: metrics.containerWidth,
        containerHeight: metrics.containerHeight,
        vy: speed * 1.05,
        caught: false,
        missed: false,
        isBomb: true,
        isGoldenMandi: false,
        itemType: "bomb"
      });
      return;
    }

    // Food item (normal or golden mandi)
    const baseFood = FOOD_TYPES[Math.floor(Math.random() * FOOD_TYPES.length)];
    const foodConfig = isGoldenMandi ? {
      id: "golden-mandi",
      name: "Golden Mandi",
      image: baseFood.image
    } : baseFood;

    const el = createFoodElement(foodConfig, metrics);
    const startY = -metrics.containerHeight;
    el.style.transform = `translate3d(${startX}px, ${startY}px, 0)`;
    fallingItemsLayer.appendChild(el);

    fallingItems.push({
      el,
      x: startX,
      y: startY,
      imageHeight: metrics.imageHeight,
      containerWidth: metrics.containerWidth,
      containerHeight: metrics.containerHeight,
      vy: speed,
      caught: false,
      missed: false,
      isBomb: false,
      isGoldenMandi,
      itemType: isGoldenMandi ? "golden-mandi" : "normal"
    });
  }

  // Handle successful item catch — Food visibly drops into the open bucket interior
  function handleCatch(item, index) {
    if (item.caught || gameState !== "playing") return;
    item.caught = true;

    const eventTime = Math.max(0, Math.round(performance.now() - roundStartTime));
    const catchCenterX = item.x + item.containerWidth / 2;
    const catchCenterY = item.y;

    // Bucket pulse feedback
    [bucketRear, bucketFront].forEach((b) => {
      if (!b) return;
      b.classList.remove("is-caught-pulse");
      void b.offsetWidth;
      b.classList.add("is-caught-pulse");
    });

    // 1. Handling Bomb Hazard Catch (-10 points, resets combo, no miss, no food count)
    if (item.isBomb) {
      if (GAME_FEATURES.bomb) {
        score = Math.max(0, score + (GAME_CONFIG.bombPoints || -10));
        consecutiveCatches = 0; // Reset combo streak!
        updateEnhancementsHUD();

        Sound.bombHit();

        if (GAME_FEATURES.floatingScores) {
          spawnFloatingPopup("-10", "is-bomb-deduction", catchCenterX, catchCenterY, 750);
        }

        roundEvents.push({
          type: "catch",
          itemType: "bomb",
          timestamp: eventTime
        });
      }
    }
    // 2. Handling Food Catch (Normal Food or Golden Mandi)
    else {
      foodCaughtCount++;
      consecutiveCatches++;

      const hitComboActivation = (consecutiveCatches === (GAME_CONFIG.comboActivationCount || 5));
      const scoring = getCatchScoring(item.itemType);
      score += scoring.awardedPoints;

      // Play sound
      if (item.isGoldenMandi) {
        Sound.goldenMandiCatch();
      } else {
        Sound.normalCatch();
      }

      // Combo activation effect
      if (hitComboActivation && GAME_FEATURES.comboCatch) {
        Sound.comboActivation();
        updateEnhancementsHUD(true);
        if (GAME_FEATURES.floatingScores) {
          setTimeout(() => spawnFloatingPopup("COMBO x2!", "is-combo-popup", catchCenterX, catchCenterY - 24, 750), 120);
        }
      } else {
        updateEnhancementsHUD(false);
      }

      // Record telemetry for server-side verification
      roundEvents.push({
        type: "catch",
        itemType: item.itemType,
        timestamp: eventTime
      });

      // Floating Scores
      if (GAME_FEATURES.floatingScores) {
        if (item.isGoldenMandi && GAME_FEATURES.goldenMandi) {
          spawnFloatingPopup(`+${scoring.awardedPoints} BONUS!`, "is-golden-bonus", catchCenterX, catchCenterY, 750);
        } else {
          spawnFloatingPopup(`+${scoring.awardedPoints}`, "is-floating-score", catchCenterX, catchCenterY, 650);
        }
      } else {
        // Fallback popup if all features disabled: show simple +1
        const allDisabled = !GAME_FEATURES.goldenMandi && !GAME_FEATURES.comboCatch && !GAME_FEATURES.floatingScores && !GAME_FEATURES.bomb;
        if (allDisabled) {
          const popup = document.createElement("div");
          popup.className = "catch-popup";
          popup.textContent = "+1";
          popup.style.left = `${catchCenterX}px`;
          popup.style.top = `${catchCenterY}px`;
          gamePlayArea.appendChild(popup);
          setTimeout(() => popup.remove(), 550);
        }
      }
    }

    // Update Live Score on HUD immediately with pop animation
    if (gameScoreEl) {
      gameScoreEl.textContent = String(score);
      gameScoreEl.classList.remove("pop");
      void gameScoreEl.offsetWidth;
      gameScoreEl.classList.add("pop");
    }

    // Trigger visual pop animation on the caught item
    const currentTransform = `translate3d(${item.x}px, ${item.y}px, 0)`;
    item.el.style.setProperty("--current-transform", currentTransform);
    item.el.classList.add("is-caught");

    setTimeout(() => {
      if (item.el && item.el.parentNode) {
        item.el.remove();
      }
    }, 360);

    fallingItems.splice(index, 1);
  }

  // Clear all falling items from DOM and memory
  function clearFallingItems() {
    if (fallingItemsLayer) {
      fallingItemsLayer.innerHTML = "";
    }
    fallingItems = [];
    lastSpawnX = -999;
  }

  // Main Game Loop (requestAnimationFrame) — Ends solely on 5 misses
  function gameLoop(now) {
    if (gameState !== "playing" || isGamePaused) return;

    if (!lastFrameTime) lastFrameTime = now;
    const dt = Math.min(0.1, (now - lastFrameTime) / 1000);
    lastFrameTime = now;

    // Spawning cadence
    spawnCooldown -= dt;
    if (spawnCooldown <= 0) {
      spawnFoodItem();
      spawnCooldown = GAME_CONFIG.minSpawnInterval + Math.random() * (GAME_CONFIG.maxSpawnInterval - GAME_CONFIG.minSpawnInterval);
    }

    // Update falling items & accurate collision detection
    const metrics = getPlayfieldMetrics();
    const areaRect = gamePlayArea.getBoundingClientRect();
    const areaHeight = areaRect.height || 500;

    // 3D Bucket Rim Geometry:
    const bucketTop = areaHeight - metrics.bucketHeight - 8;
    const bucketRimTop = bucketTop + metrics.bucketHeight * 0.155;
    const bucketFrontLip = bucketTop + metrics.bucketHeight * 0.367;

    // Catch zone: Food platter enters into the bucket cavity
    const catchTop = bucketRimTop - 4;
    const catchBottom = bucketFrontLip + metrics.bucketHeight * 0.12;

    // Bucket opening horizontal bounds (~80% of bucket width accounting for side padding)
    const openingHalfWidth = metrics.bucketWidth * 0.40;
    const bucketLeft = bucketX - openingHalfWidth;
    const bucketRight = bucketX + openingHalfWidth;

    for (let i = fallingItems.length - 1; i >= 0; i--) {
      const item = fallingItems[i];
      if (item.caught) continue;

      item.y += item.vy * dt;
      item.el.style.transform = `translate3d(${item.x}px, ${item.y}px, 0)`;

      // Collision calculated based strictly on item reaching the rim
      const itemBottom = item.y + (item.isBomb ? 50 : item.imageHeight * 0.90);
      const itemCenter = item.x + item.containerWidth / 2;

      // 1. Successful Catch Check
      if (
        itemBottom >= catchTop &&
        itemBottom <= catchBottom &&
        itemCenter >= bucketLeft &&
        itemCenter <= bucketRight
      ) {
        handleCatch(item, i);
        continue;
      }

      // 2. Item leaves bottom of playfield
      if (item.y > areaHeight + 25) {
        if (!item.caught && !item.missed) {
          item.missed = true;

          // Safe avoidance for bomb: no penalty, no miss count increment, no combo reset!
          if (item.isBomb) {
            roundEvents.push({
              type: "miss",
              itemType: "bomb",
              timestamp: Math.max(0, Math.round(performance.now() - roundStartTime))
            });
          } else {
            // Food item miss (Normal or Golden Mandi)
            missedCount++;
            updateMissesDisplay();

            // Reset combo streak on food miss
            if (GAME_FEATURES.comboCatch) {
              consecutiveCatches = 0;
              updateEnhancementsHUD();
            }

            if (missedCount === 4) {
              Sound.missWarning();
            }

            roundEvents.push({
              type: "miss",
              itemType: item.itemType || "normal",
              timestamp: Math.max(0, Math.round(performance.now() - roundStartTime))
            });

            if (missedCount >= MAX_MISSES) {
              item.el.remove();
              fallingItems.splice(i, 1);
              Sound.gameOver();
              endGameLoss();
              return;
            }
          }
        }
        item.el.remove();
        fallingItems.splice(i, 1);
      }
    }

    gameAnimId = requestAnimationFrame(gameLoop);
  }

  // Update Misses HUD Display (e.g. "0/5", "4/5" with warning pulse, "5/5")
  function updateMissesDisplay() {
    if (gameMissesEl) {
      gameMissesEl.textContent = `${missedCount}/${MAX_MISSES}`;
    }
    if (hudMissesEl) {
      if (missedCount >= 4) {
        hudMissesEl.classList.add("is-warning");
      } else {
        hudMissesEl.classList.remove("is-warning");
      }
    }
    if (hudMissWarningEl) {
      if (missedCount === 4) {
        hudMissWarningEl.classList.add("is-visible");
      } else {
        hudMissWarningEl.classList.remove("is-visible");
      }
    }
  }

  function stopDraggingBucket(event) {
    if (activePointerId !== null && event && event.pointerId !== undefined && event.pointerId !== activePointerId) {
      return;
    }
    isDraggingBucket = false;
    dragOffsetX = 0;
    activePointerId = null;
    [bucketRear, bucketFront].forEach((b) => {
      if (b) b.classList.remove("is-moving-left", "is-moving-right");
    });
    try {
      if (gamePlayArea && event && event.pointerId !== undefined && gamePlayArea.hasPointerCapture(event.pointerId)) {
        gamePlayArea.releasePointerCapture(event.pointerId);
      }
    } catch (_) {}
  }

  // =========================================================================
  // GAME PAUSE & RESUME SYSTEM
  // =========================================================================
  function pauseGame() {
    // Only allow pausing during active gameplay
    if (gameState !== "playing" || isGamePaused) return;

    isGamePaused = true;
    pauseStartTime = performance.now();

    // 1. Cancel active animation loop immediately
    if (gameAnimId) {
      cancelAnimationFrame(gameAnimId);
      gameAnimId = null;
    }

    // 2. Stop dragging bucket
    stopDraggingBucket();

    // 3. Update Pause Overlay stats
    if (pauseStatScore) {
      pauseStatScore.textContent = String(score);
    }
    if (pauseStatCombo) {
      pauseStatCombo.textContent = consecutiveCatches >= 5 ? "x2" : "x1";
    }
    if (pauseStatMisses) {
      pauseStatMisses.textContent = `${missedCount}/${MAX_MISSES}`;
    }

    // 4. Reveal Pause Overlay
    if (gamePauseOverlay) {
      gamePauseOverlay.style.display = "flex";
      gamePauseOverlay.setAttribute("aria-hidden", "false");
    }

    // 5. Update HUD Pause Button state
    if (hudPauseBtn) {
      hudPauseBtn.classList.add("is-paused");
      hudPauseBtn.setAttribute("aria-pressed", "true");
    }

    trackEvent("game_pause", { score, missedCount, combo: consecutiveCatches });
  }

  function resumeGame() {
    // Only allow resuming if currently playing and paused
    if (gameState !== "playing" || !isGamePaused) return;

    // 1. Shift roundStartTime by paused duration to ensure fair session duration and event timestamps
    if (pauseStartTime > 0) {
      const pausedDuration = performance.now() - pauseStartTime;
      if (pausedDuration > 0) {
        roundStartTime += pausedDuration;
      }
    }
    pauseStartTime = 0;
    isGamePaused = false;

    // 2. Set lastFrameTime to now so dt does not jump on the first resumed frame
    lastFrameTime = performance.now();

    // 3. Hide Pause Overlay
    if (gamePauseOverlay) {
      gamePauseOverlay.style.display = "none";
      gamePauseOverlay.setAttribute("aria-hidden", "true");
    }

    // 4. Reset HUD Pause Button state
    if (hudPauseBtn) {
      hudPauseBtn.classList.remove("is-paused");
      hudPauseBtn.setAttribute("aria-pressed", "false");
    }

    // 5. Restart single animation loop
    if (!gameAnimId) {
      gameAnimId = requestAnimationFrame(gameLoop);
    }

    trackEvent("game_resume", { score, missedCount, combo: consecutiveCatches });
  }

  function togglePause() {
    if (gameState !== "playing") return;
    if (isGamePaused) {
      resumeGame();
    } else {
      pauseGame();
    }
  }

  // Start / Restart Catch the Feast game
  // Clears pause state and hides the pause overlay (used when starting a round or leaving it).
  function clearPauseState() {
    isGamePaused = false;
    pauseStartTime = 0;
    if (gamePauseOverlay) {
      gamePauseOverlay.style.display = "none";
      gamePauseOverlay.setAttribute("aria-hidden", "true");
    }
    if (hudPauseBtn) {
      hudPauseBtn.classList.remove("is-paused");
      hudPauseBtn.setAttribute("aria-pressed", "false");
    }
  }

  function startGame() {
    if (!isAuthenticated) return;
    stopDraggingBucket();
    updatePlayAreaRect();

    // Reset any pause state
    clearPauseState();

    // Advance round identifier so any in-flight background submissions from previous rounds are discarded
    currentRoundId++;

    // Clear any previous animation loops, timers, or confetti
    if (gameAnimId) {
      cancelAnimationFrame(gameAnimId);
      gameAnimId = null;
    }
    if (offerTransitionTimer) {
      clearTimeout(offerTransitionTimer);
      offerTransitionTimer = null;
    }
    clearFallingItems();
    stopConfetti();

    const isReplay = (gameState === "revealed");
    trackEvent("game_start", { isReplay });

    // Reset game round state completely - zero score carryover
    gameState = "playing";
    score = 0;
    missedCount = 0;
    consecutiveCatches = 0;
    foodCaughtCount = 0;
    itemsSpawnedTotal = 0;
    roundEvents = [];
    spawnCooldown = 0.22; // First food item spawns promptly
    lastFrameTime = 0;
    hasMovedBucket = false;
    roundStartTime = performance.now();
    pendingScoreSubmission = null;
    currentGameSessionId = null;
    scoreVerification = { status: "idle", roundId: null, payload: null, verifiedScore: null, gameSessionId: null };
    currentGameSessionPromise = fetch("/api/game/start", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    }).then(res => res.ok ? res.json() : null).then(data => {
        if (data && data.success) {
            currentGameSessionId = data.gameSessionId;
            return data.gameSessionId;
        }
        return null;
    }).catch(() => null);

    updateEnhancementsHUD();

    // Reset Container & Reward Card State
    try {
      sessionStorage.removeItem("soofi_mandi_active_view");
      sessionStorage.removeItem("soofi_mandi_current_session_id");
      sessionStorage.removeItem(GAME_OVER_STATE_KEY);
      sessionStorage.removeItem(PLAYING_GAME_STATE_KEY);
    } catch (_) {}

    if (rewardScoreNumber) {
      rewardScoreNumber.textContent = "0";
    }
    if (rewardScoreSummary) {
      rewardScoreSummary.textContent = "Reach 100 points to unlock your reward!";
    }
    if (rewardResultHeader) {
      rewardResultHeader.style.display = "";
    }
    if (rewardCard) {
      rewardCard.classList.remove("is-loss", "is-offer-unlocked", "is-offer-revealed");
      rewardCard.setAttribute("aria-hidden", "true");
    }
    if (rewardLockedWrap) {
      rewardLockedWrap.style.display = "none";
    }
    if (rewardUnlockBanner) {
      rewardUnlockBanner.style.display = "none";
    }
    if (rewardOfferCard) {
      rewardOfferCard.style.display = "none";
    }
    if (rewardLossHeadline) {
      rewardLossHeadline.style.display = "none";
    }

    // Reset HUD
    if (gameScoreEl) gameScoreEl.textContent = "0";
    if (bucketDragIndicator) bucketDragIndicator.classList.remove("is-hidden");
    updateMissesDisplay();

    // Show Playing View with enlarged playfield & center bucket
    switchView(viewPlaying, "playing");
    centerBucket();

    // Start single active requestAnimationFrame loop
    gameAnimId = requestAnimationFrame(gameLoop);
  }

  function configureRoundResult(finalScore, finalCaught) {
    const scoreSummaryText = finalCaught === 1 ? "You caught 1 food item!" : `You caught ${finalCaught} food items!`;

    if (interstitialScoreVal) interstitialScoreVal.textContent = String(finalScore);
    if (interstitialScoreDesc) interstitialScoreDesc.textContent = scoreSummaryText;
    if (rewardResultHeader) rewardResultHeader.style.display = "";
    if (rewardScoreNumber) rewardScoreNumber.textContent = String(finalScore);

    const rewardScoreDetail = document.getElementById("reward-score-detail");
    if (rewardScoreDetail) rewardScoreDetail.textContent = scoreSummaryText;
    if (rewardCard) {
      rewardCard.classList.remove("is-loss", "is-offer-unlocked", "is-offer-revealed");
      rewardCard.setAttribute("aria-hidden", "false");
    }
    if (rewardKicker) rewardKicker.textContent = "GAME OVER";
    if (rewardOfferCard) rewardOfferCard.style.display = "none";
    if (rewardLossHeadline) rewardLossHeadline.style.display = "none";

    // The browser's score is never trusted for the offer: the unlock/locked result is shown only
    // after the server verifies the round (applyVerifiedResult). Until then, show a pending state.
    if (scoreVerification.status === "verified" && Number.isFinite(scoreVerification.verifiedScore)) {
      applyVerifiedResult(scoreVerification.verifiedScore);
    } else if (scoreVerification.status === "failed") {
      showScoreVerificationState("failed", "Your score has not been verified yet. Please retry.");
    } else {
      showScoreVerificationState("pending");
    }
  }

  // End of Round: Triggered immediately when player reaches 5 missed food items
  function endGameLoss() {
    stopDraggingBucket();
    isGamePaused = false;
    pauseStartTime = 0;
    if (gamePauseOverlay) {
      gamePauseOverlay.style.display = "none";
      gamePauseOverlay.setAttribute("aria-hidden", "true");
    }
    if (hudPauseBtn) {
      hudPauseBtn.classList.remove("is-paused");
      hudPauseBtn.setAttribute("aria-pressed", "false");
    }

    if (gameState !== "playing") return;
    gameState = "revealed";

    if (gameAnimId) {
      cancelAnimationFrame(gameAnimId);
      gameAnimId = null;
    }

    if (offerTransitionTimer) {
      clearTimeout(offerTransitionTimer);
      offerTransitionTimer = null;
    }

    clearFallingItems();
    stopConfetti();

    if (hudEnhancementsStrip) hudEnhancementsStrip.style.display = "none";

    // Preserve the actual final score for THIS isolated round
    const thisRoundId = currentRoundId;
    const finalScore = score;
    const finalCaught = foodCaughtCount;
    const finalEvents = [...roundEvents];
    const wasDevRound = Boolean(isDevTestRound);
    const elapsedSeconds = Math.max(1, Math.round((performance.now() - roundStartTime) / 1000));
    // One submission payload per round, reused unchanged for any retry.
    scoreVerification = {
      status: "idle",
      roundId: thisRoundId,
      verifiedScore: null,
      gameSessionId: null,
      payload: {
        roundId: thisRoundId,
        score: finalScore,
        foodCaught: finalCaught,
        missedCount: MAX_MISSES,
        durationSeconds: elapsedSeconds,
        events: finalEvents,
        isDevTest: wasDevRound,
        gameSessionId: currentGameSessionId || null
      }
    };
    configureRoundResult(finalScore, finalCaught);
    persistGameOverState(true);
    try {
      sessionStorage.removeItem(PLAYING_GAME_STATE_KEY);
    } catch (error) {
      console.warn("Unable to clear the saved in-progress game.", error);
    }

    // 4. Reveal the Result Screen
    switchView(null, "revealed");

    // 5. Track event and submit score to global leaderboard
    trackEvent("game_loss", {
      score: finalScore,
      foodCaught: finalCaught,
      missedCount: MAX_MISSES,
      durationSeconds: elapsedSeconds
    });
    trackEvent("game_complete", {
      score: finalScore,
      foodCaught: finalCaught,
      missedCount: MAX_MISSES,
      durationSeconds: elapsedSeconds
    });
    verifyRoundScore();
    isDevTestRound = false;
  }

  const endGameRound = endGameLoss;

  /**
   * =========================================================================
   * FULL-SCREEN CONFETTI CELEBRATION OVERLAY
   * Renders particles across the full viewport, passing visibly IN FRONT of card!
   * =========================================================================
   */
  function triggerFullScreenConfetti() {
    if (!fullscreenConfettiOverlay) return;

    // Respect reduced-motion preferences
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return;
    }

    stopConfetti();

    // Palette with vibrant gold, cream, forest green, and sand for celebratory theme
    const confettiPalette = [
      "#F5B800",
      "#FFD24D",
      "#D99E00",
      "#FFF8E7",
      "#F0E3C4",
      "#7BD88F",
      "#1B5E45"
    ];

    const isMobile = window.innerWidth < 600;
    const cascadeCount = isMobile ? 36 : 64;
    const cannonCount = isMobile ? 14 : 26;
    const burstCount = isMobile ? 12 : 20;

    // 1. Top Cascading Shower
    for (let i = 0; i < cascadeCount; i++) {
      const piece = document.createElement("div");
      piece.className = "confetti-particle";

      const color = confettiPalette[Math.floor(Math.random() * confettiPalette.length)];
      piece.style.backgroundColor = color;
      piece.style.boxShadow = `0 1px 4px ${color}66`;

      const shapeRand = Math.random();
      if (shapeRand < 0.55) {
        piece.style.width = `${6 + Math.random() * 4}px`;
        piece.style.height = `${11 + Math.random() * 8}px`;
        piece.style.borderRadius = "1.5px";
      } else if (shapeRand < 0.8) {
        const s = 6 + Math.random() * 4;
        piece.style.width = `${s}px`;
        piece.style.height = `${s}px`;
        piece.style.borderRadius = "2px";
      } else {
        const d = 6 + Math.random() * 3.5;
        piece.style.width = `${d}px`;
        piece.style.height = `${d}px`;
        piece.style.borderRadius = "50%";
      }

      const xStart = 3 + Math.random() * 94; // 3vw to 97vw
      const lateralDrift = (Math.random() - 0.5) * (isMobile ? 70 : 160);
      const rotX = (Math.random() - 0.5) * 1440;
      const rotY = (Math.random() - 0.5) * 1440;
      const rotZ = (Math.random() - 0.5) * 720;

      piece.style.setProperty("--x-start", `${xStart}vw`);
      piece.style.setProperty("--x-end", `calc(${xStart}vw + ${lateralDrift}px)`);
      piece.style.setProperty("--rot-x", `${rotX}deg`);
      piece.style.setProperty("--rot-y", `${rotY}deg`);
      piece.style.setProperty("--rot-z", `${rotZ}deg`);

      const duration = 2.4 + Math.random() * 1.1;
      const delay = Math.random() * 0.75;

      piece.style.animationName = "confetti-cascade";
      piece.style.animationDuration = `${duration}s`;
      piece.style.animationDelay = `${delay}s`;
      piece.style.animationTimingFunction = "cubic-bezier(0.22, 0.7, 0.35, 1)";

      fullscreenConfettiOverlay.appendChild(piece);
    }

    // 2. Left & Right Cannon Blasts
    for (let i = 0; i < cannonCount; i++) {
      spawnCannonPiece(true);
      spawnCannonPiece(false);
    }

    function spawnCannonPiece(isLeft) {
      const piece = document.createElement("div");
      piece.className = "confetti-particle";

      const color = confettiPalette[Math.floor(Math.random() * confettiPalette.length)];
      piece.style.backgroundColor = color;
      piece.style.boxShadow = `0 1px 4px ${color}66`;

      const w = 6 + Math.random() * 3.5;
      const h = 10 + Math.random() * 7;
      piece.style.width = `${w}px`;
      piece.style.height = `${h}px`;
      piece.style.borderRadius = "1.5px";

      piece.style.left = isLeft ? "0px" : "100vw";
      piece.style.top = isMobile ? "75vh" : "70vh";

      const minDx = isMobile ? 80 : 180;
      const maxDx = isMobile ? 240 : 600;
      const dxVal = minDx + Math.random() * (maxDx - minDx);
      const dx = isLeft ? dxVal : -dxVal;

      const apexY = -(isMobile ? 180 + Math.random() * 140 : 280 + Math.random() * 280);
      const fallY = isMobile ? 80 + Math.random() * 120 : 100 + Math.random() * 200;
      const rot = (isLeft ? 1 : -1) * (360 + Math.random() * 720);

      piece.style.setProperty("--dx", `${dx}px`);
      piece.style.setProperty("--apex-y", `${apexY}px`);
      piece.style.setProperty("--fall-y", `${fallY}px`);
      piece.style.setProperty("--rot", `${rot}deg`);

      const duration = 2.5 + Math.random() * 0.9;
      const delay = Math.random() * 0.22;

      piece.style.animationName = isLeft ? "confetti-cannon-left" : "confetti-cannon-right";
      piece.style.animationDuration = `${duration}s`;
      piece.style.animationDelay = `${delay}s`;
      piece.style.animationTimingFunction = "cubic-bezier(0.15, 0.85, 0.3, 1)";

      fullscreenConfettiOverlay.appendChild(piece);
    }

    // 3. Center Burst
    for (let i = 0; i < burstCount; i++) {
      const piece = document.createElement("div");
      piece.className = "confetti-particle";

      const color = confettiPalette[Math.floor(Math.random() * confettiPalette.length)];
      piece.style.backgroundColor = color;
      piece.style.boxShadow = `0 1px 4px ${color}66`;

      const s = 6 + Math.random() * 3.5;
      piece.style.width = `${s}px`;
      piece.style.height = `${s}px`;
      piece.style.borderRadius = Math.random() > 0.4 ? "2px" : "50%";

      const cx = 50; // 50vw
      const cy = isMobile ? 48 : 46; // vh
      const angle = Math.random() * Math.PI * 2;
      const distance = (isMobile ? 70 : 180) + Math.random() * (isMobile ? 80 : 220);
      const dx = Math.cos(angle) * distance;
      const dy = Math.sin(angle) * distance - 40; // Bias upward
      const rot = (Math.random() - 0.5) * 720;

      piece.style.setProperty("--cx", `${cx}vw`);
      piece.style.setProperty("--cy", `${cy}vh`);
      piece.style.setProperty("--dx", `${dx}px`);
      piece.style.setProperty("--dy", `${dy}px`);
      piece.style.setProperty("--rot", `${rot}deg`);

      const duration = 2.2 + Math.random() * 0.8;
      const delay = Math.random() * 0.15;

      piece.style.animationName = "confetti-burst-radial";
      piece.style.animationDuration = `${duration}s`;
      piece.style.animationDelay = `${delay}s`;
      piece.style.animationTimingFunction = "cubic-bezier(0.15, 0.8, 0.3, 1)";

      fullscreenConfettiOverlay.appendChild(piece);
    }

    // Self-cleanup after animation completes
    confettiCleanupTimer = setTimeout(() => {
      stopConfetti();
    }, 4500);
  }

  function stopConfetti() {
    if (confettiCleanupTimer) {
      clearTimeout(confettiCleanupTimer);
      confettiCleanupTimer = null;
    }
    if (fullscreenConfettiOverlay) {
      fullscreenConfettiOverlay.innerHTML = "";
    }
  }

  // Full Demo Reset: returns cleanly to Intro Screen
  function resetDemo() {
    stopDraggingBucket();
    if (gameAnimId) {
      cancelAnimationFrame(gameAnimId);
      gameAnimId = null;
    }
    if (offerTransitionTimer) {
      clearTimeout(offerTransitionTimer);
      offerTransitionTimer = null;
    }
    clearFallingItems();
    stopConfetti();

    gameState = "intro";
    score = 0;
    missedCount = 0;
    currentGameSessionId = null;
    pendingScoreSubmission = null;
    scoreVerification = { status: "idle", roundId: null, payload: null, verifiedScore: null, gameSessionId: null };

    try {
      sessionStorage.removeItem("soofi_mandi_active_view");
      sessionStorage.removeItem(GAME_OVER_STATE_KEY);
      sessionStorage.removeItem(PLAYING_GAME_STATE_KEY);
    } catch (_) {}

    if (rewardCard) {
      rewardCard.classList.remove("is-loss", "is-offer-unlocked", "is-offer-revealed");
      rewardCard.setAttribute("aria-hidden", "true");
    }
    if (rewardUnlockBanner) {
      rewardUnlockBanner.style.display = "none";
    }
    if (rewardOfferCard) {
      rewardOfferCard.style.display = "none";
    }
    if (rewardLossHeadline) {
      rewardLossHeadline.style.display = "none";
    }

    if (gameScoreEl) gameScoreEl.textContent = "0";
    updateMissesDisplay();

    switchView(viewIntro, "intro");
  }

  // Bucket Drag Event Listeners (Pointer Events for Touch & Mouse)
  if (gamePlayArea) {
    gamePlayArea.addEventListener("pointerdown", (event) => {
      if (gameState !== "playing" || isGamePaused) return;
      event.preventDefault();
      updatePlayAreaRect();
      isDraggingBucket = true;
      activePointerId = event.pointerId;

      const rect = cachedPlayAreaRect || gamePlayArea.getBoundingClientRect();
      const currentTouchX = event.clientX - rect.left;
      const metrics = getPlayfieldMetrics();

      // If touched on or near bucket, smoothly track offset so the bucket NEVER jumps!
      if (Math.abs(currentTouchX - bucketX) < metrics.bucketWidth * 0.8) {
        dragOffsetX = currentTouchX - bucketX;
      } else {
        dragOffsetX = 0;
        setBucketPosition(event.clientX, 0);
      }

      try {
        gamePlayArea.setPointerCapture(event.pointerId);
      } catch (_) {}
    }, { passive: false });

    gamePlayArea.addEventListener("pointermove", (event) => {
      if (gameState !== "playing" || isGamePaused) return;
      if (activePointerId !== null && event.pointerId !== activePointerId) return;
      if (isDraggingBucket || event.pointerType === "mouse") {
        setBucketPosition(event.clientX, isDraggingBucket ? dragOffsetX : 0);
      }
    }, { passive: true });

    gamePlayArea.addEventListener("pointerup", stopDraggingBucket);
    gamePlayArea.addEventListener("pointercancel", stopDraggingBucket);
    gamePlayArea.addEventListener("lostpointercapture", stopDraggingBucket);

    // Window-level safety listeners in case pointer leaves or capture is dropped by browser
    window.addEventListener("pointermove", (event) => {
      if (gameState !== "playing" || isGamePaused || !isDraggingBucket) return;
      if (activePointerId !== null && event.pointerId !== activePointerId) return;
      setBucketPosition(event.clientX, dragOffsetX);
    }, { passive: true });

    window.addEventListener("pointerup", stopDraggingBucket);
    window.addEventListener("pointercancel", stopDraggingBucket);

    // Keyboard Controls for Bucket (Accessibility: Left/Right Arrow Keys)
    window.addEventListener("keydown", (event) => {
      if (gameState !== "playing" || isGamePaused) return;
      if (!cachedPlayAreaRect) updatePlayAreaRect();
      const rect = cachedPlayAreaRect || gamePlayArea.getBoundingClientRect();
      const metrics = getPlayfieldMetrics();
      const halfWidth = metrics.bucketWidth / 2;
      const step = 32;

      if (event.key === "ArrowLeft") {
        event.preventDefault();
        const newX = Math.max(halfWidth + 6, bucketX - step);
        [bucketRear, bucketFront].forEach((b) => {
          if (!b) return;
          b.style.left = `${newX}px`;
          b.classList.remove("is-moving-right");
          b.classList.add("is-moving-left");
        });
        bucketX = newX;
        if (bucketDragIndicator) bucketDragIndicator.classList.add("is-hidden");
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        const newX = Math.min(rect.width - halfWidth - 6, bucketX + step);
        [bucketRear, bucketFront].forEach((b) => {
          if (!b) return;
          b.style.left = `${newX}px`;
          b.classList.remove("is-moving-left");
          b.classList.add("is-moving-right");
        });
        bucketX = newX;
        if (bucketDragIndicator) bucketDragIndicator.classList.add("is-hidden");
      }
    });

    window.addEventListener("keyup", (event) => {
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        [bucketRear, bucketFront].forEach((b) => {
          if (b) b.classList.remove("is-moving-left", "is-moving-right");
        });
      }
    });
  }

  // Recalculate and clamp bucket on window resize
  window.addEventListener("resize", () => {
    updatePlayAreaRect();
    if (gamePlayArea && bucketFront) {
      const rect = cachedPlayAreaRect || gamePlayArea.getBoundingClientRect();
      const metrics = getPlayfieldMetrics();
      const halfWidth = metrics.bucketWidth / 2;
      bucketX = Math.max(halfWidth + 6, Math.min(rect.width - halfWidth - 6, bucketX));
      [bucketRear, bucketFront].forEach((b) => {
        if (b) b.style.left = `${bucketX}px`;
      });
    }
  });

  window.addEventListener("scroll", () => {
    updatePlayAreaRect();
  }, { passive: true });

  // Pre-game countdown (3 · 2 · 1 · GO!) shown after PLAY / PLAY AGAIN. startGame() itself is
  // unchanged, so dev tools and automation still start instantly. Repeat clicks during the
  // countdown are ignored, so a round can only be started once.
  const gameCountdown = document.getElementById("game-countdown");
  const gameCountdownNumber = document.getElementById("game-countdown-number");
  let countdownActive = false;

  function runStartCountdown(onDone) {
    if (countdownActive || gameState === "playing") return;
    if (!gameCountdown || !gameCountdownNumber) {
      onDone();
      return;
    }
    countdownActive = true;
    const steps = ["3", "2", "1", "GO!"];
    const stepMs = 700;
    gameCountdown.hidden = false;
    gameCountdown.classList.remove("is-leaving", "is-go");
    requestAnimationFrame(() => gameCountdown.classList.add("is-visible"));

    let index = 0;
    const showStep = () => {
      const label = steps[index];
      const isGo = label === "GO!";
      gameCountdownNumber.textContent = label;
      gameCountdownNumber.classList.toggle("is-go", isGo);
      gameCountdown.classList.toggle("is-go", isGo);
      gameCountdownNumber.classList.remove("is-tick");
      void gameCountdownNumber.offsetWidth; // restart the pop animation
      gameCountdownNumber.classList.add("is-tick");

      if (!isGo) {
        index += 1;
        window.setTimeout(showStep, stepMs);
        return;
      }
      window.setTimeout(() => {
        gameCountdown.classList.add("is-leaving");
        gameCountdown.classList.remove("is-visible");
        onDone();
        window.setTimeout(() => {
          gameCountdown.hidden = true;
          gameCountdown.classList.remove("is-leaving", "is-go");
          countdownActive = false;
        }, 300);
      }, 550);
    };
    showStep();
  }

  // Action Button Listeners
  if (startGameBtn) {
    startGameBtn.addEventListener("click", () => {
      if (countdownActive) return;
      trackEvent("cta_click", { target: "start_game" });
      runStartCountdown(startGame);
    });
  }

  if (playAgainBtn) {
    playAgainBtn.addEventListener("click", () => {
      if (countdownActive) return;
      trackEvent("game_replay");
      trackEvent("cta_click", { target: "play_again" });
      runStartCountdown(startGame);
    });
  }

  if (openLeaderboardBtn) {
    openLeaderboardBtn.addEventListener("click", () => {
      trackEvent("cta_click", { target: "open_leaderboard_intro" });
      openLeaderboard();
    });
  }

  if (resultLeaderboardBtn) {
    resultLeaderboardBtn.addEventListener("click", () => {
      trackEvent("cta_click", { target: "open_leaderboard_result" });
      openLeaderboard();
    });
  }

  if (closeLeaderboardBtn) {
    closeLeaderboardBtn.addEventListener("click", closeLeaderboard);
  }

  if (doneLeaderboardBtn) {
    doneLeaderboardBtn.addEventListener("click", closeLeaderboard);
  }

  if (leaderboardModal) {
    leaderboardModal.addEventListener("click", (event) => {
      if (event.target === leaderboardModal) {
        closeLeaderboard();
      }
    });
  }

  if (playerChipEditBtn) {
    playerChipEditBtn.addEventListener("click", () => {
      openLeaderboard();
      if (playerNameInput) {
        playerNameInput.focus();
        playerNameInput.select();
      }
    });
  }

  if (playerLogoutBtn) {
    playerLogoutBtn.addEventListener("click", async () => {
      playerLogoutBtn.disabled = true;
      try {
        // Server revokes the session row and clears the HttpOnly session cookie.
        const response = await fetch("/api/auth/logout", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: "{}"
        });
        if (response.ok) {
          // Forget this player's on-device offer view so the next person on a shared device
          // cannot have it restored, then return to the homepage, which shows the phone login.
          try {
            sessionStorage.removeItem("soofi_mandi_active_view");
            sessionStorage.removeItem(GAME_OVER_STATE_KEY);
            sessionStorage.removeItem(PLAYING_GAME_STATE_KEY);
            localStorage.removeItem("soofi_mandi_latest_claim");
          } catch (_) {}
          window.location.replace("/");
        } else {
          playerLogoutBtn.disabled = false;
        }
      } catch (_) {
        playerLogoutBtn.disabled = false;
      }
    });
  }

  // Home: return to the game homepage (intro screen) without touching the session.
  // Shared by the header Home link.
  function goHome(event) {
    if (event) event.preventDefault();
    if (gameState === "playing") {
      trackEvent("game_abandon", { score, missedCount });
    }
    if (claimModal && claimModal.classList.contains("is-open")) closeClaimModal();
    if (leaderboardModal && leaderboardModal.classList.contains("is-open")) closeLeaderboard();
    clearPauseState();
    resetDemo();
    window.scrollTo(0, 0);
  }

  if (playerNavHome) playerNavHome.addEventListener("click", goHome);

  if (saveNameBtn) {
    saveNameBtn.addEventListener("click", savePlayerName);
  }

  if (playerNameInput) {
    playerNameInput.addEventListener("input", () => {
      clearPlayerNameFeedback();
    });
    playerNameInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        savePlayerName();
      }
    });
  }

  // Pause Button in HUD & Resume Button on Overlay
  if (hudPauseBtn) {
    hudPauseBtn.addEventListener("click", togglePause);
  }

  if (resumeGameBtn) {
    resumeGameBtn.addEventListener("click", resumeGame);
  }

  // Keyboard navigation for modal (ESC key to dismiss) & Pause toggle (ESC or P)
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (leaderboardModal && leaderboardModal.classList.contains("is-open")) {
        closeLeaderboard();
        return;
      }
      if (claimModal && claimModal.classList.contains("is-open")) {
        closeClaimModal();
        return;
      }
      if (gameState === "playing") {
        event.preventDefault();
        togglePause();
        return;
      }
    }
    if (event.key === "p" || event.key === "P") {
      const activeTag = document.activeElement ? document.activeElement.tagName.toLowerCase() : "";
      if (activeTag === "input" || activeTag === "textarea") return;
      if (gameState === "playing") {
        event.preventDefault();
        togglePause();
      }
    }
  });

  // =========================================================================
  // CUSTOMER OFFER UNLOCK & CLAIM MODAL LOGIC
  // Flow: Score 100+ -> Unlock My Offer -> Customer Details Form ->
  //       Continue -> Reveal Special Offer -> Save Claim to Neon PostgreSQL
  // =========================================================================

  function openClaimModal() {
    if (!claimModal) return;
    claimModal.classList.add("is-open");
    claimModal.setAttribute("aria-hidden", "false");

    clearClaimErrors();
    if (claimNameInput) claimNameInput.value = "";

    // Auto-focus the first field
    if (claimNameInput) {
      setTimeout(() => claimNameInput.focus(), 80);
    }

    trackEvent("claim_modal_open", { score, gameSessionId: currentGameSessionId });
  }

  function closeClaimModal() {
    if (!claimModal) return;
    claimModal.classList.remove("is-open");
    claimModal.setAttribute("aria-hidden", "true");
    clearClaimErrors();
  }

  function clearClaimErrors() {
    if (claimNameError) claimNameError.textContent = "";
    if (claimPhoneError) claimPhoneError.textContent = "";
    if (claimEmailError) claimEmailError.textContent = "";
    if (claimAlertError) {
      claimAlertError.textContent = "";
      claimAlertError.style.display = "none";
    }
    if (claimNameInput) claimNameInput.classList.remove("is-invalid");
    if (claimPhoneInput) claimPhoneInput.classList.remove("is-invalid");
    if (claimEmailInput) claimEmailInput.classList.remove("is-invalid");
  }

  function validateClaimForm() {
    clearClaimErrors();

    const fullName = (claimNameInput ? claimNameInput.value : "").trim();

    let isValid = true;

    // 1. Full Name: Required, min 2 characters
    if (!fullName || fullName.length < 2) {
      if (claimNameError) claimNameError.textContent = "Please enter your full name (minimum 2 characters).";
      if (claimNameInput) claimNameInput.classList.add("is-invalid");
      isValid = false;
    }

    if (!isValid) {
      if (claimNameInput && claimNameInput.classList.contains("is-invalid")) {
        claimNameInput.focus();
      }
    }

    return { isValid, fullName };
  }

  // Friendly popup for a rejected offer claim (by HTTP status; server text is not shown).
  function showClaimErrorPopup(status, modalIsOpen) {
    if (status === 400 && modalIsOpen && claimNameError) {
      // Name problem inside the claim form: keep it next to the field.
      claimNameError.textContent = "Please enter your full name (2–64 characters).";
      if (claimNameInput) {
        claimNameInput.classList.add("is-invalid");
        claimNameInput.focus();
      }
      return;
    }
    if (status === 401) return showErrorPopup("session", { key: "claim-session", message: "Your sign-in has expired. Please sign in again to unlock your offer." });
    if (status === 403) return showErrorPopup("claim", { key: "claim-ineligible", title: "Offer locked", message: "This offer unlocks only for a verified score of 100 points or more." });
    if (status === 404) return showErrorPopup("claim", { key: "claim-missing", title: "Round not found", message: "We couldn't find this round. Please play a new round to unlock your offer." });
    if (status === 429) return showErrorPopup("claim", { key: "claim-busy", title: "Please wait a moment", message: "Too many attempts. Wait a few seconds and try again." });
    return showErrorPopup("server", { key: "claim-server", title: "Couldn't unlock your offer", message: "Our server had a hiccup. Please try again in a moment." });
  }

  async function submitOfferClaim(fullName) {
    const modalIsOpen = Boolean(claimModal && claimModal.classList.contains("is-open"));
    // A claim is only possible for a round the server has verified at 100+. The unlock button is
    // shown only in that state; this guards direct calls and restored screens as well.
    if (scoreVerification.status === "pending" && pendingScoreSubmission) {
      await pendingScoreSubmission;
    }
    if (scoreVerification.status !== "verified" || !scoreVerification.gameSessionId ||
        !(scoreVerification.verifiedScore >= 100)) {
      if (scoreVerification.status === "failed" || scoreVerification.status === "verified") {
        // Failed verification shows its own error + retry; a verified score < 100 has no offer.
        if (scoreVerification.status === "verified") applyVerifiedResult(scoreVerification.verifiedScore);
      } else {
        showErrorPopup("scoreVerify", { key: "claim-unverified", title: "Score not verified", message: "We couldn't confirm this round's score, so the offer can't be unlocked. Please play a new round." });
      }
      return;
    }
    currentGameSessionId = scoreVerification.gameSessionId;

    if (modalIsOpen) {
      if (claimSubmitBtn) claimSubmitBtn.disabled = true;
      if (claimSpinner) claimSpinner.style.display = "inline-block";
      if (claimSubmitText) claimSubmitText.textContent = "CLAIMING...";
    } else {
      if (unlockOfferBtn) unlockOfferBtn.disabled = true;
      if (unlockOfferError) {
        unlockOfferError.textContent = "";
        unlockOfferError.style.display = "none";
      }
    }

    try {
      const requestBody = { gameSessionId: currentGameSessionId };
      if (typeof fullName === "string") requestBody.fullName = fullName;
      const response = await fetch("/api/offers/claim", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody)
      });

      let data = null;
      try { data = await response.json(); } catch (_) {}

      if (response.status === 428 && data && data.code === "player_name_required") {
        openClaimModal();
        return;
      }

      if (!response.ok || !data || !data.success) {
        showClaimErrorPopup(response.status, modalIsOpen);
        return;
      }

      const claim = data.claim;
      currentClaim = claim;

      try {
        localStorage.setItem("soofi_mandi_latest_claim", JSON.stringify(claim));
      } catch (_) {}

      if (claim.fullName) {
        playerDisplayName = claim.fullName.substring(0, 20);
        try {
          localStorage.setItem("soofi_mandi_display_name", playerDisplayName);
        } catch (_) {}
        updateDisplayNameUI(playerDisplayName);
      }

      closeClaimModal();
      triggerFullScreenConfetti();
      revealSpecialOffer(claim);
    } catch (err) {
      showErrorPopup("network", {
        key: "claim-network",
        message: "We couldn't unlock your offer because the connection dropped. Check your internet and try again.",
        actions: [
          { label: "Close", value: "close" },
          { label: "Try again", value: "retry", primary: true, onClick: () => submitOfferClaim(fullName) }
        ]
      });
    } finally {
      if (claimSubmitBtn) claimSubmitBtn.disabled = false;
      if (claimSpinner) claimSpinner.style.display = "none";
      if (claimSubmitText) claimSubmitText.textContent = "CONTINUE";
      if (unlockOfferBtn) unlockOfferBtn.disabled = false;
    }
  }

  async function handleClaimSubmit(event) {
    if (event) event.preventDefault();

    const { isValid, fullName } = validateClaimForm();
    if (!isValid) return;
    await submitOfferClaim(fullName);
  }

  function revealSpecialOffer(claim) {
    if (!claim) return;

    if (rewardCard) {
      rewardCard.classList.remove("is-loss", "is-offer-unlocked");
      rewardCard.classList.add("is-offer-revealed");
      rewardCard.setAttribute("aria-hidden", "false");
    }

    if (rewardKicker) {
      rewardKicker.textContent = "✦ OFFER REVEALED ✦";
    }

    // Completely remove score header and offer buttons from the final reveal screen
    if (rewardResultHeader) {
      rewardResultHeader.style.display = "none";
    }
    if (rewardLockedWrap) {
      rewardLockedWrap.style.display = "none";
    }
    if (rewardUnlockBanner) {
      rewardUnlockBanner.style.display = "none";
    }
    if (offerLockedBtn) {
      offerLockedBtn.style.display = "none";
    }
    if (unlockOfferBtn) {
      unlockOfferBtn.style.display = "none";
    }
    if (rewardLossHeadline) {
      rewardLossHeadline.style.display = "none";
    }

    const offer = claim.offer || (demoOffers && demoOffers[0]) || {
      badge: "YOUR FEAST REWARD",
      title: "Complimentary Yemeni Delicacy",
      description: "Enjoy a special feast reward with your dine-in experience.",
      instructions: "Show this screen to our staff to claim your reward."
    };

    const offerBadgeEl = document.getElementById("offer-badge");
    if (offerBadgeEl) {
      offerBadgeEl.textContent = offer.badge || "YOUR FEAST REWARD";
      offerBadgeEl.style.display = "none";
    }

    const congratsHeadingEl = document.getElementById("offer-congrats-heading");
    if (congratsHeadingEl) {
      congratsHeadingEl.textContent = "🎉 YOUR OFFER IS UNLOCKED!";
    }

    const congratsSubEl = document.getElementById("offer-congrats-sub");
    if (congratsSubEl) {
      congratsSubEl.textContent = "Enjoy your special reward!";
    }

    const offerTitleEl = document.getElementById("offer-title");
    if (offerTitleEl && offer.title) {
      offerTitleEl.textContent = offer.title;
    }

    const offerDescEl = document.getElementById("offer-description");
    if (offerDescEl && offer.description) {
      offerDescEl.textContent = offer.description;
    }

    const offerClaimCodeEl = document.getElementById("offer-claim-code");
    if (offerClaimCodeEl) {
      const codeStr = claim.claimId
        ? claim.claimId.replace(/^claim_/, "SOOFI-").toUpperCase().substring(0, 16)
        : "SOOFI-REWARD";
      offerClaimCodeEl.textContent = codeStr;
    }

    const instructionsEl = document.getElementById("offer-instructions-text");
    if (instructionsEl) {
      // Fixed redemption copy for the instruction card (staff verify the screenshot).
      instructionsEl.textContent = OFFER_REDEEM_INSTRUCTIONS;
    }

    if (rewardOfferCard) {
      rewardOfferCard.style.display = "flex";
    }

    try {
      sessionStorage.setItem("soofi_mandi_active_view", "revealed");
      sessionStorage.setItem("soofi_mandi_current_session_id", claim.gameSessionId || "");
    } catch (_) {}

    switchView(null, "revealed");
  }

  function restoreSavedClaimIfActive() {
    try {
      const activeView = sessionStorage.getItem("soofi_mandi_active_view");
      const savedClaimRaw = localStorage.getItem("soofi_mandi_latest_claim");
      if (activeView === "revealed" && savedClaimRaw) {
        const savedClaim = JSON.parse(savedClaimRaw);
        if (savedClaim && savedClaim.claimId) {
          currentClaim = savedClaim;
          currentGameSessionId = savedClaim.gameSessionId || null;
          revealSpecialOffer(savedClaim);
          return true;
        }
      }
    } catch (_) {}
    return false;
  }

  // Saves the game-over screen with its verification state and the exact submission payload, so a
  // refresh can resume (or idempotently re-confirm) server verification without a new session.
  function persistGameOverState(activate = false) {
    try {
      if (activate) {
        sessionStorage.setItem("soofi_mandi_active_view", "game-over");
      } else if (sessionStorage.getItem("soofi_mandi_active_view") !== "game-over") {
        return;
      }
      const payload = scoreVerification.payload;
      if (!payload) return;
      sessionStorage.setItem(GAME_OVER_STATE_KEY, JSON.stringify({
        playerId,
        score: payload.score,
        foodCaught: payload.foodCaught,
        gameSessionId: scoreVerification.gameSessionId || payload.gameSessionId || null,
        payload: { ...payload, roundId: undefined }
      }));
    } catch (error) {
      console.warn("Unable to save the game-over screen for refresh restoration.", error);
    }
  }

  function restoreSavedGameOverIfActive() {
    try {
      if (sessionStorage.getItem("soofi_mandi_active_view") !== "game-over") return false;
      const savedState = JSON.parse(sessionStorage.getItem(GAME_OVER_STATE_KEY) || "null");
      if (
        !savedState ||
        savedState.playerId !== playerId ||
        !Number.isSafeInteger(savedState.score) ||
        savedState.score < 0 ||
        !Number.isSafeInteger(savedState.foodCaught) ||
        savedState.foodCaught < 0
      ) {
        sessionStorage.removeItem("soofi_mandi_active_view");
        sessionStorage.removeItem(GAME_OVER_STATE_KEY);
        return false;
      }

      score = savedState.score;
      foodCaughtCount = savedState.foodCaught;
      missedCount = MAX_MISSES;
      const savedSessionId = typeof savedState.gameSessionId === "string" ? savedState.gameSessionId : null;
      currentGameSessionId = savedSessionId;
      gameState = "revealed";
      // Never restore a "verified" result from browser storage: re-confirm with the server. The
      // saved payload carries the round's gameSessionId, so the server returns the stored verified
      // score (or verifies it now) without consuming another session.
      const saved = savedState.payload && typeof savedState.payload === "object" ? savedState.payload : null;
      currentRoundId += 1;
      scoreVerification = {
        status: "idle",
        roundId: currentRoundId,
        verifiedScore: null,
        gameSessionId: null,
        payload: saved ? {
          roundId: currentRoundId,
          score: savedState.score,
          foodCaught: savedState.foodCaught,
          missedCount: Number.isSafeInteger(saved.missedCount) ? saved.missedCount : MAX_MISSES,
          durationSeconds: Number.isFinite(saved.durationSeconds) ? saved.durationSeconds : 1,
          events: Array.isArray(saved.events) ? saved.events : [],
          isDevTest: saved.isDevTest === true,
          gameSessionId: savedSessionId
        } : null
      };
      currentGameSessionPromise = Promise.resolve(savedSessionId);
      configureRoundResult(score, foodCaughtCount);
      switchView(null, "revealed");
      if (scoreVerification.payload) {
        verifyRoundScore();
      } else {
        scoreVerification.status = "failed";
        showScoreVerificationState("failed", "This round could not be verified after the page reloaded. Please play a new round.");
        if (scoreVerifyRetry) scoreVerifyRetry.hidden = true;
        showScoreVerificationPopup("rejected");
      }
      return true;
    } catch (error) {
      console.warn("Unable to restore the saved game-over screen.", error);
      return false;
    }
  }

  function persistPlayingGameState() {
    if (gameState !== "playing" || !isAuthenticated || !playerId) return;
    try {
      sessionStorage.setItem("soofi_mandi_active_view", "playing");
      sessionStorage.setItem(PLAYING_GAME_STATE_KEY, JSON.stringify({
        playerId,
        score,
        missedCount,
        foodCaughtCount,
        consecutiveCatches,
        itemsSpawnedTotal,
        roundEvents,
        isDevTestRound,
        elapsedMs: Math.max(0, Math.round(performance.now() - roundStartTime))
      }));
    } catch (error) {
      console.warn("Unable to save the in-progress game for refresh restoration.", error);
    }
  }

  function restoreSavedPlayingGameIfActive() {
    try {
      if (sessionStorage.getItem("soofi_mandi_active_view") !== "playing") return false;
      const savedState = JSON.parse(sessionStorage.getItem(PLAYING_GAME_STATE_KEY) || "null");
      if (
        !savedState ||
        savedState.playerId !== playerId ||
        !Number.isSafeInteger(savedState.score) ||
        !Number.isSafeInteger(savedState.missedCount) ||
        savedState.missedCount < 0 ||
        savedState.missedCount >= MAX_MISSES ||
        !Number.isSafeInteger(savedState.foodCaughtCount) ||
        savedState.foodCaughtCount < 0 ||
        !Number.isSafeInteger(savedState.consecutiveCatches) ||
        savedState.consecutiveCatches < 0 ||
        !Number.isSafeInteger(savedState.itemsSpawnedTotal) ||
        savedState.itemsSpawnedTotal < 0 ||
        !Array.isArray(savedState.roundEvents) ||
        !Number.isFinite(savedState.elapsedMs) ||
        savedState.elapsedMs < 0
      ) {
        sessionStorage.removeItem("soofi_mandi_active_view");
        sessionStorage.removeItem(PLAYING_GAME_STATE_KEY);
        return false;
      }

      score = savedState.score;
      missedCount = savedState.missedCount;
      foodCaughtCount = savedState.foodCaughtCount;
      consecutiveCatches = savedState.consecutiveCatches;
      itemsSpawnedTotal = savedState.itemsSpawnedTotal;
      roundEvents = savedState.roundEvents;
      isDevTestRound = savedState.isDevTestRound === true;
      roundStartTime = performance.now() - savedState.elapsedMs;
      gameState = "playing";
      isGamePaused = false;
      pauseStartTime = 0;
      spawnCooldown = 0.22;
      lastFrameTime = 0;
      lastSpawnX = -999;
      fallingItems = [];
      hasMovedBucket = false;

      if (gameScoreEl) gameScoreEl.textContent = String(score);
      updateEnhancementsHUD();
      updateMissesDisplay();
      switchView(viewPlaying, "playing");
      centerBucket();
      gameAnimId = requestAnimationFrame(gameLoop);
      return true;
    } catch (error) {
      console.warn("Unable to restore the in-progress game.", error);
      return false;
    }
  }

  function clearSavedPlayerState() {
    try {
      sessionStorage.removeItem("soofi_mandi_active_view");
      sessionStorage.removeItem("soofi_mandi_current_session_id");
      sessionStorage.removeItem(GAME_OVER_STATE_KEY);
      sessionStorage.removeItem(PLAYING_GAME_STATE_KEY);
      localStorage.removeItem("soofi_mandi_latest_claim");
    } catch (error) {
      console.warn("Unable to clear saved player state.", error);
    }
  }

  // Offer Flow Event Listeners
  if (unlockOfferBtn) {
    unlockOfferBtn.addEventListener("click", () => {
      trackEvent("cta_click", { target: "unlock_my_offer" });
      submitOfferClaim();
    });
  }

  if (closeClaimModalBtn) {
    closeClaimModalBtn.addEventListener("click", closeClaimModal);
  }

  if (claimModal) {
    claimModal.addEventListener("click", (event) => {
      if (event.target === claimModal) {
        closeClaimModal();
      }
    });
  }

  if (claimForm) {
    claimForm.addEventListener("submit", handleClaimSubmit);
  }

  // Clear validation styling when user starts correcting inputs
  [
    { el: claimNameInput, err: claimNameError },
    { el: claimPhoneInput, err: claimPhoneError },
    { el: claimEmailInput, err: claimEmailError }
  ].forEach(({ el, err }) => {
    if (el) {
      el.addEventListener("input", () => {
        el.classList.remove("is-invalid");
        if (err) err.textContent = "";
        if (claimAlertError) claimAlertError.style.display = "none";
      });
    }
  });

  // Window lifecycle tracking (game abandon & session)
  window.addEventListener("beforeunload", () => {
    if (gameState === "playing") {
      persistPlayingGameState();
      trackEvent("game_abandon", { score, missedCount });
    }
  });
  window.addEventListener("pagehide", persistPlayingGameState);

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && gameState === "playing") {
      if (!isGamePaused) {
        pauseGame();
      }
      trackEvent("game_abandon", { score, missedCount });
    }
  });

  if (resetBtn) {
    resetBtn.addEventListener("click", resetDemo);
  }

  if (introResetBtn) {
    introResetBtn.addEventListener("click", resetDemo);
  }

  if (rewardResetBtn) {
    rewardResetBtn.addEventListener("click", resetDemo);
  }

  // Upper bound on the boot-time session check so the loading screen can never hang:
  // a stalled request is aborted and handled like any other verification failure.
  const SESSION_CHECK_TIMEOUT_MS = 10000;

  async function restoreAuthenticationSession() {
    const abortController = typeof AbortController === "function" ? new AbortController() : null;
    const timeoutId = abortController ? setTimeout(() => abortController.abort(), SESSION_CHECK_TIMEOUT_MS) : null;
    try {
      updateDisplayNameUI(playerDisplayName);
      const response = await fetch("/api/player/session", {
        credentials: "same-origin",
        cache: "no-store",
        signal: abortController ? abortController.signal : undefined
      });
      if (!response.ok) throw new Error("Session verification request failed.");
      const result = await response.json();

      if (result && result.success === true && result.authenticated === true && typeof result.playerId === "string" && result.playerId) {
        isAuthenticated = true;
        playerId = result.playerId;
        loginScreen.hidden = true;
        document.body.classList.add("is-authenticated");
        if (loginError) loginError.textContent = "";
        trackEvent("page_visit", { path: window.location.pathname });
        if (isNewSession) trackEvent("session_start");
        const restored = restoreSavedClaimIfActive() || restoreSavedGameOverIfActive() || restoreSavedPlayingGameIfActive();
        if (!restored) switchView(viewIntro, "intro");
        return;
      }

      if (!result || result.success !== true || result.authenticated !== false) {
        throw new Error("Session verification returned an invalid response.");
      }

      isAuthenticated = false;
      playerId = "";
      document.body.classList.remove("is-authenticated");
      clearSavedPlayerState();
      loginScreen.hidden = false;
      if (loginError) loginError.textContent = "";
    } catch (error) {
      isAuthenticated = false;
      playerId = "";
      document.body.classList.remove("is-authenticated");
      loginScreen.hidden = false;
      if (loginError) loginError.textContent = "";
      showErrorPopup("network", {
        key: "session-restore",
        title: "Couldn't verify your sign-in",
        message: "We couldn't check your sign-in. Check your connection and try again, or sign in below.",
        actions: [
          { label: "Close", value: "close" },
          { label: "Try again", value: "retry", primary: true, onClick: () => window.location.reload() }
        ]
      });
      console.error("Player session restoration failed.");
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      document.body.classList.remove("auth-pending");
    }
  }

  restoreAuthenticationSession();

  // Development Testing Helper (Active strictly on local development hostnames)
  // True only in development environments where dev controls are safe.
  // - NODE_ENV=test: always allowed (tests run with their own database)
  // - NODE_ENV=development: always allowed
  // - NODE_ENV=production with LOCAL_DEV=1: allowed for local server runs
  // - Any hostname check for localhost etc: allowed as fallback for non-Vercel or custom-local envs
  // `process` does not exist in browsers; reading it unguarded threw a ReferenceError that
  // aborted the rest of this script (dev-panel removal, test hooks) on every page load.
  const runtimeEnv = (typeof process !== "undefined" && process && process.env) ? process.env : {};
  const isLocalDev = Boolean(
    typeof window !== "undefined" &&
    (runtimeEnv.NODE_ENV === "test" ||
     runtimeEnv.NODE_ENV === "development" ||
     (runtimeEnv.NODE_ENV === "production" && runtimeEnv.LOCAL_DEV === "1") ||
     window.location.hostname === "localhost" ||
     window.location.hostname === "127.0.0.1" ||
     window.location.hostname === "0.0.0.0" ||
     window.location.hostname === "[::1]" ||
     window.location.hostname.startsWith("192.168.") ||
     window.location.hostname.endsWith(".local"))
  );

  function forceSpawnGoldenMandi() {
    if (!isLocalDev) {
      console.warn("Dev spawn actions are STRICTLY DISABLED in production. Only allowed in NODE_ENV=test, development, or production with LOCAL_DEV=1.");
      return;
    }
    if (gameState !== "playing") return;
    spawnFoodItem("golden-mandi");
  }

  function forceSpawnBomb() {
    if (!isLocalDev) {
      console.warn("Dev spawn actions are STRICTLY DISABLED in production. Only allowed in NODE_ENV=test, development, or production with LOCAL_DEV=1.");
      return;
    }
    if (gameState !== "playing") return;
    spawnFoodItem("bomb");
  }

  function setFeatures(newFeatures = {}) {
    if (!isLocalDev) {
      console.warn("Dynamic feature toggles are DISABLED in production. Only allowed in NODE_ENV=test, development, or production with LOCAL_DEV=1.");
      return;
    }
    Object.assign(GAME_FEATURES, newFeatures);
    if (typeof window !== "undefined") {
      window.GAME_FEATURES = Object.assign({}, GAME_FEATURES);
    }
    updateEnhancementsHUD();
    syncDevCheckboxes();
  }

  function getFeatures() {
    return Object.assign({}, GAME_FEATURES);
  }

  function syncDevCheckboxes() {
    const cbGm = document.getElementById("dev-toggle-gm");
    const cbCc = document.getElementById("dev-toggle-cc");
    const cbFs = document.getElementById("dev-toggle-fs");
    const cbBm = document.getElementById("dev-toggle-bm");
    if (cbGm) cbGm.checked = Boolean(GAME_FEATURES.goldenMandi);
    if (cbCc) cbCc.checked = Boolean(GAME_FEATURES.comboCatch);
    if (cbFs) cbFs.checked = Boolean(GAME_FEATURES.floatingScores);
    if (cbBm) cbBm.checked = Boolean(GAME_FEATURES.bomb);
  }

  function testOfferUnlock(targetScore = 121) {
    if (!isLocalDev) {
      console.warn("Dev score injection requires NODE_ENV=test, development, or production with LOCAL_DEV=1.");
      return;
    }
    startGame();
    isDevTestRound = true;
    const simulatedDurationSeconds = Math.max(20, Math.ceil(targetScore / 2.2));
    roundStartTime = performance.now() - (simulatedDurationSeconds * 1000);
    score = targetScore;
    foodCaughtCount = targetScore;
    roundEvents = [];
    endGameLoss();
  }

  // Dev Testing Panel markup lives only here (not in index.html), so production pages on
  // Vercel/Netlify never contain it. It is inserted into the DOM exclusively on local hosts.
  const DEV_PANEL_HTML = `<aside class="dev-test-panel" id="dev-test-panel" aria-label="Development Testing Controls">
  <div class="dev-panel-header">
    <span class="dev-test-label">⚡ DEV CONTROLS</span>
    <button type="button" class="dev-btn dev-btn-close" id="dev-btn-close" aria-label="Close Dev Panel">✕</button>
  </div>
  <div class="dev-panel-section">
    <span class="dev-section-title">Feature Toggles:</span>
    <div class="dev-toggles-row">
      <label class="dev-toggle-chip"><input type="checkbox" id="dev-toggle-gm" checked> GM (+3/+6)</label>
      <label class="dev-toggle-chip"><input type="checkbox" id="dev-toggle-cc" checked> Combo (x2)</label>
      <label class="dev-toggle-chip"><input type="checkbox" id="dev-toggle-fs" checked> Float</label>
      <label class="dev-toggle-chip"><input type="checkbox" id="dev-toggle-bm" checked> Bomb (-10)</label>
    </div>
    <div class="dev-btn-group">
      <button type="button" class="dev-btn dev-btn-sm" id="dev-btn-all-on">All ON</button>
      <button type="button" class="dev-btn dev-btn-sm" id="dev-btn-all-off">All OFF (Original)</button>
    </div>
  </div>
  <div class="dev-panel-section">
    <span class="dev-section-title">Gameplay Spawns:</span>
    <div class="dev-btn-group">
      <button type="button" class="dev-btn dev-btn-sm dev-btn-gold" id="dev-btn-spawn-mandi">Spawn Golden Mandi</button>
      <button type="button" class="dev-btn dev-btn-sm dev-btn-bomb" id="dev-btn-spawn-bomb">Spawn Bomb</button>
    </div>
  </div>
  <div class="dev-panel-section">
    <span class="dev-section-title">Offer Simulation:</span>
    <div class="dev-btn-group">
      <button type="button" class="dev-btn dev-btn-121" id="dev-btn-score-121" title="Generate test score 121 (Unlock Offer)">Score 121</button>
      <button type="button" class="dev-btn dev-btn-100" id="dev-btn-score-100" title="Generate test score 100 (Threshold)">Score 100</button>
      <button type="button" class="dev-btn dev-btn-80" id="dev-btn-score-80" title="Generate test score 80 (Under 100)">Score 80</button>
    </div>
  </div>
</aside>`;

  const devTestPanel = isLocalDev ? (() => {
    document.body.insertAdjacentHTML("beforeend", DEV_PANEL_HTML);
    return document.getElementById("dev-test-panel");
  })() : null;
  if (devTestPanel) {
      devTestPanel.style.display = "flex";
      syncDevCheckboxes();

      // Checkboxes
      const cbGm = document.getElementById("dev-toggle-gm");
      if (cbGm) cbGm.addEventListener("change", (e) => setFeatures({ goldenMandi: e.target.checked }));
      const cbCc = document.getElementById("dev-toggle-cc");
      if (cbCc) cbCc.addEventListener("change", (e) => setFeatures({ comboCatch: e.target.checked }));
      const cbFs = document.getElementById("dev-toggle-fs");
      if (cbFs) cbFs.addEventListener("change", (e) => setFeatures({ floatingScores: e.target.checked }));
      const cbBm = document.getElementById("dev-toggle-bm");
      if (cbBm) cbBm.addEventListener("change", (e) => setFeatures({ bomb: e.target.checked }));

      // All ON / All OFF
      const btnAllOn = document.getElementById("dev-btn-all-on");
      if (btnAllOn) btnAllOn.addEventListener("click", () => setFeatures({ goldenMandi: true, comboCatch: true, floatingScores: true, bomb: true }));
      const btnAllOff = document.getElementById("dev-btn-all-off");
      if (btnAllOff) btnAllOff.addEventListener("click", () => setFeatures({ goldenMandi: false, comboCatch: false, floatingScores: false, bomb: false }));

      // Spawns
      const btnSpawnMandi = document.getElementById("dev-btn-spawn-mandi");
      if (btnSpawnMandi) btnSpawnMandi.addEventListener("click", () => {
        if (gameState !== "playing") startGame();
        forceSpawnGoldenMandi();
      });
      const btnSpawnBomb = document.getElementById("dev-btn-spawn-bomb");
      if (btnSpawnBomb) btnSpawnBomb.addEventListener("click", () => {
        if (gameState !== "playing") startGame();
        forceSpawnBomb();
      });

      // Score Simulation
      const devBtn121 = document.getElementById("dev-btn-score-121");
      if (devBtn121) devBtn121.addEventListener("click", () => testOfferUnlock(121));
      const devBtn100 = document.getElementById("dev-btn-score-100");
      if (devBtn100) devBtn100.addEventListener("click", () => testOfferUnlock(100));
      const devBtn80 = document.getElementById("dev-btn-score-80");
      if (devBtn80) devBtn80.addEventListener("click", () => testOfferUnlock(80));
      const devBtnClose = document.getElementById("dev-btn-close");
      if (devBtnClose) devBtnClose.addEventListener("click", () => { devTestPanel.style.display = "none"; });
  }

  // Expose test & diagnostic hooks (local development only; never on production hosts)
  if (typeof window !== "undefined" && isLocalDev) {
    window.__soofiGame = {
      startGame,
      endGameLoss,
      pauseGame,
      resumeGame,
      togglePause,
      isPaused: () => isGamePaused,
      isLocalDev: () => isLocalDev,
      submitScore,
      resetDemo,
      openClaimModal,
      closeClaimModal,
      handleClaimSubmit,
      revealSpecialOffer,
      testOfferUnlock,
      savePlayerName,
      getPlayerDisplayName: () => playerDisplayName,
      getPlayerId: () => playerId,
      forceSpawnGoldenMandi,
      forceSpawnBomb,
      setFeatures,
      getFeatures,
      getState: () => ({
        gameState,
        score,
        foodCaughtCount,
        missedCount,
        consecutiveCatches,
        isPaused: isGamePaused,
        currentGameSessionId,
        currentClaim,
        features: Object.assign({}, GAME_FEATURES)
      }),
      setScore: (val) => { score = val; },
      setRoundStartTime: (val) => { roundStartTime = val; }
    };
  }
})();
