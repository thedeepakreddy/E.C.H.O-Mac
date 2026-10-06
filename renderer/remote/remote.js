/*
 * Echo's phone remote.
 *
 * Plain script, no framework and no build step: it is served as-is by the
 * remote's own server, and the Mac is the only origin it may talk to. Every
 * piece of text from the Mac (feed lines, task goals, project names) is set
 * with textContent and never parsed as markup — a filename on screen must not
 * be able to inject script into a phone that can drive the machine.
 */
(function () {
  "use strict";

  var T = document.currentScript.getAttribute("data-t");
  var sess = store("js_sess") || "";
  var body = document.body;
  var $ = function (id) { return document.getElementById(id); };

  function store(key, value) {
    try {
      if (value === undefined) return localStorage.getItem(key);
      if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value);
    } catch (e) { /* private browsing: fine, it just won't be remembered */ }
    return null;
  }
  function u(path) {
    return path + (path.indexOf("?") < 0 ? "?" : "&") + "t=" + T + (sess ? "&s=" + sess : "");
  }
  function request(path, payload) {
    var opts = payload === undefined ? {} : {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    };
    return fetch(u(path), opts).then(function (r) {
      if (r.status === 401) { signedOut(); throw new Error("signed out"); }
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok && d && d.ok === undefined) d.ok = false;
        return d;
      });
    });
  }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  var toastTimer = 0;
  function toast(text, bad) {
    var t = $("toast");
    t.textContent = text;
    t.className = "toast mono show" + (bad ? " bad" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = "toast mono"; }, 2600);
  }
  function clock(ms) { return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }); }
  function span(sec) {
    sec = Math.max(0, Math.floor(sec));
    var d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
    if (d) return d + "d " + h + "h";
    if (h) return h + "h " + m + "m";
    return m + "m " + (sec % 60) + "s";
  }
  window.onerror = function (msg, src, line, col) {
    fetch(u("/log"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ msg: String(msg), line: line, col: col }) }).catch(function () {});
  };

  // ---- sign in -------------------------------------------------------------
  $("login-host").textContent = location.hostname;
  $("login-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var pw = $("pw").value;
    var err = $("login-err");
    err.textContent = "";
    if (!pw) { err.textContent = "Enter your password first."; return; }
    $("signin").disabled = true;
    fetch(u("/login"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: pw }) })
      .then(function (r) { if (r.ok) return r.json(); throw r.status; })
      .then(function (d) {
        sess = d.s || "";
        store("js_sess", sess);
        $("pw").value = "";
        enter();
      })
      .catch(function (s) {
        err.textContent = s === 401 ? "Wrong password." : s === 404 ? "Too many attempts. This address is locked out." : "Couldn't reach the Mac.";
      })
      .then(function () { $("signin").disabled = false; });
  });
  $("pw").addEventListener("input", function () { $("login-err").textContent = ""; });

  function signedOut() {
    if (!sess) return;
    sess = "";
    started = false; // the poll loops stop on their own once sess is empty
    store("js_sess", null);
    $("app").hidden = true;
    $("login").hidden = false;
    $("login-err").textContent = "Signed out. Enter your password again.";
  }

  var started = false;
  function enter() {
    $("login").hidden = true;
    $("app").hidden = false;
    showPage(store("echo_page") || "core");
    if (started) return;
    started = true;
    pollStatus();
    pollPending();
    pollEvents();
  }

  // ---- pages ---------------------------------------------------------------
  var PAGES = ["core", "screen", "work", "feed", "system"];
  function showPage(name) {
    if (PAGES.indexOf(name) < 0) name = "core";
    PAGES.forEach(function (p) { $("page-" + p).hidden = p !== name; });
    document.querySelectorAll(".tabs button").forEach(function (b) {
      if (b.getAttribute("data-page") === name) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
    });
    $("pages").scrollTop = 0;
    store("echo_page", name);
    // The screen stream starts only when someone looks at it, so the Mac is
    // not capturing (and showing its recording light) for a phone on Core.
    if (name === "screen") connectRTC(); else stopFrames();
  }
  document.querySelectorAll(".tabs button").forEach(function (b) {
    b.addEventListener("click", function () { showPage(b.getAttribute("data-page")); });
  });
  document.addEventListener("click", function (e) {
    var go = e.target.closest && e.target.closest("[data-goto]");
    if (go) showPage(go.getAttribute("data-goto"));
  });

  // ---- live status ---------------------------------------------------------
  var STATE_LABEL = {
    idle: "STANDING BY", listening: "LISTENING", thinking: "THINKING", acting: "TAKING ACTION",
    speaking: "SPEAKING", asleep: "ASLEEP", error: "ERROR",
  };
  var logsAfter = 0, misses = 0, last = null;

  function pollStatus() {
    request("/status?logs=" + logsAfter).then(function (d) {
      if (!d || d.error) throw new Error(d && d.error);
      misses = 0;
      body.removeAttribute("data-link");
      $("link-dot").className = "dot ok";
      render(d);
    }).catch(function () {
      if (++misses >= 2) {
        body.setAttribute("data-link", "down");
        $("link-dot").className = "dot bad";
        $("state-label").textContent = "NO LINK TO THE MAC";
      }
    }).then(function () {
      if (sess) setTimeout(pollStatus, document.hidden ? 8000 : 2000);
    });
  }

  function render(d) {
    last = d;
    var status = STATE_LABEL[d.status] ? d.status : "idle";
    body.setAttribute("data-status", status);
    $("state-label").textContent = STATE_LABEL[status];
    $("brain-line").textContent = d.brain ? "brain · " + d.brain.model : "brain · none";
    renderVitals(d.vitals || {}, d.analytics || {});
    renderLink(d.remote || {});
    renderActive(d);
    renderWork(d);
    renderFeedLogs(d.logs || []);
    renderSystem(d);
  }

  function renderVitals(v, a) {
    var b = v.battery;
    var load = v.load ? v.load[0] : null;
    $("v-batt").textContent = b ? b.percent + "%" : "AC";
    $("v-batt2").textContent = b ? (b.charging ? "charging" : b.remaining ? b.remaining.replace(":", "h ") + "m" : "estimating") : "no battery";
    $("v-load").textContent = load === null ? "—" : load.toFixed(2);
    $("v-cores").textContent = v.cores ? v.cores + " cores" : "";
    $("v-up").textContent = v.uptimeSec ? span(v.uptimeSec) : "—";
    $("v-cmds").textContent = (a.commands || 0) + " commands";
    $("mac-name").textContent = v.chip || "Mac";
    $("sys-id").textContent = [v.os, v.chip, v.memGB ? v.memGB + " GB" : ""].filter(Boolean).join(" · ");
    $("s-batt").textContent = b ? b.percent + "%" : "AC";
    $("s-batt2").textContent = $("v-batt2").textContent;
    $("s-batt-bar").style.width = (b ? b.percent : 100) + "%";
    $("s-load").textContent = $("v-load").textContent;
    $("s-load-bar").style.width = load === null || !v.cores ? "0" : Math.min(100, Math.round(load / v.cores * 100)) + "%";
    $("a-cmds").textContent = a.commands || 0;
    $("a-tools").textContent = a.toolCalls || 0;
    $("a-errs").textContent = a.errors || 0;
    $("session-age").textContent = a.uptimeSeconds ? "session · " + span(a.uptimeSeconds) : "";
  }

  function renderLink(r) {
    var where = r.host === "tailscale" ? "Tailscale" : "Wi-Fi";
    var left = r.expiresAt ? span((r.expiresAt - Date.now()) / 1000) + " left" : "always on";
    $("link-life").textContent = where + " link · " + left;
    $("link-info").textContent = where + " · " + (r.expiresAt ? "closes in " + span((r.expiresAt - Date.now()) / 1000) : "stays open across restarts") +
      (r.startedAt ? " · opened " + clock(r.startedAt) : "");
  }

  // The task on Core: a running supervised task or mission first, then the
  // turn Echo is working on right now.
  function renderActive(d) {
    var m = (d.missions || []).filter(function (x) { return x.status === "running"; })[0];
    var t = (d.tasks || []).filter(function (x) { return x.status === "working"; }).slice(-1)[0];
    var card = $("active-task");
    if (!m && !t) { card.hidden = true; $("no-task").hidden = false; return; }
    card.hidden = false;
    $("no-task").hidden = true;
    if (m) {
      var steps = m.steps || [];
      var done = steps.filter(function (s) { return s.status === "done" || s.status === "completed"; }).length;
      var current = steps.filter(function (s) { return s.status === "working"; })[0];
      $("active-title").textContent = m.goal;
      $("active-meta").textContent = steps.length ? "step " + Math.min(done + 1, steps.length) + " / " + steps.length : span((Date.now() - m.createdAt) / 1000);
      $("active-bar").style.width = steps.length ? Math.round(done / steps.length * 100) + "%" : "8%";
      $("active-step").textContent = current ? current.goal : "supervised · " + span((Date.now() - m.createdAt) / 1000);
    } else {
      $("active-title").textContent = t.title;
      $("active-meta").textContent = span((Date.now() - t.startedAt) / 1000);
      $("active-bar").style.width = "100%";
      $("active-step").textContent = "Echo is on it";
    }
  }

  // ---- approvals -----------------------------------------------------------
  var pendingId = "";
  function pollPending() {
    request("/pending").then(function (d) {
      var c = d && d.pending;
      var box = $("approval");
      if (!c || !c.id) { box.hidden = true; pendingId = ""; return; }
      if (c.id !== pendingId) {
        pendingId = c.id;
        if (navigator.vibrate) navigator.vibrate([60, 40, 60]);
      }
      box.hidden = false;
      $("approval-text").textContent = c.prompt;
      $("approval-tier").textContent = c.tier ? "risk · " + c.tier : "";
    }).catch(function () {}).then(function () {
      if (sess) setTimeout(pollPending, document.hidden ? 5000 : 1200);
    });
  }
  function answer(approved) {
    if (!pendingId) return;
    request("/confirm", { id: pendingId, approved: approved }).then(function (d) {
      $("approval").hidden = true;
      toast(d.ok ? (approved ? "Approved." : "Denied.") : "That question already closed.", !d.ok);
      pendingId = "";
    }).catch(function () { toast("Couldn't reach the Mac.", true); });
  }
  $("approve").addEventListener("click", function () { answer(true); });
  $("deny").addEventListener("click", function () { answer(false); });

  // ---- commands, stop ------------------------------------------------------
  $("cmd-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var text = $("cmd").value.trim();
    if (!text) { toast("Type a message first.", true); return; }
    sendCommand(text, "typed");
    $("cmd").value = "";
  });
  function sendCommand(text, via) {
    return request("/command", { text: text, via: via }).then(function (d) {
      if (d.ok === false) toast(d.reason || "Echo couldn't take that.", true);
    }).catch(function () { toast("Couldn't reach the Mac.", true); });
  }
  $("stop").addEventListener("click", function () {
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    request("/stop", {}).then(function () { toast("Stopped."); }).catch(function () { toast("Couldn't reach the Mac.", true); });
  });

  // ---- talking -------------------------------------------------------------
  // Speech recognised on the phone when the browser can; otherwise the raw
  // audio goes to the Mac's own Whisper. Both need a secure page on iOS, so a
  // plain-Wi-Fi link says so instead of failing silently.
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var recognition = null, heard = "", talking = false;
  var rec = null;
  function canTalk() { return !!SR || !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia); }

  function startTalk() {
    if (talking) return;
    if (!canTalk()) { toast("This browser blocks the mic on a plain Wi-Fi link. Type instead.", true); return; }
    talking = true;
    setTalkUI(true);
    if (SR) {
      recognition = new SR();
      recognition.continuous = true;
      recognition.interimResults = true;
      heard = "";
      recognition.onresult = function (event) {
        heard = "";
        for (var i = 0; i < event.results.length; i++) heard += event.results[i][0].transcript;
      };
      recognition.onerror = function (event) {
        if (event.error === "not-allowed") toast("Allow the microphone for this page to talk.", true);
      };
      recognition.onend = function () {
        var text = heard.trim();
        heard = "";
        if (text) sendCommand(text, "voice").then(function () { toast("Sent: " + text); });
      };
      try { recognition.start(); } catch (e) { /* already started */ }
    } else {
      navigator.mediaDevices.getUserMedia({ audio: true, video: false }).then(function (stream) {
        var ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
        var node = ctx.createScriptProcessor(4096, 1, 1);
        var chunks = [];
        node.onaudioprocess = function (e) {
          var data = e.inputBuffer.getChannelData(0);
          chunks.push(new Float32Array(data));
          var peak = 0;
          for (var i = 0; i < data.length; i += 16) peak = Math.max(peak, Math.abs(data[i]));
          document.documentElement.style.setProperty("--level", Math.min(1, peak * 3).toFixed(2));
        };
        ctx.createMediaStreamSource(stream).connect(node);
        node.connect(ctx.destination);
        rec = { ctx: ctx, node: node, stream: stream, chunks: chunks };
        if (!talking) stopTalk();
      }).catch(function () {
        talking = false;
        setTalkUI(false);
        toast("Allow the microphone for this page to talk.", true);
      });
    }
  }
  function stopTalk() {
    if (!talking && !rec) return;
    talking = false;
    setTalkUI(false);
    document.documentElement.style.setProperty("--level", "0");
    if (recognition) { try { recognition.stop(); } catch (e) {} recognition = null; return; }
    if (!rec) return;
    var r = rec;
    rec = null;
    r.node.disconnect();
    r.stream.getTracks().forEach(function (t) { t.stop(); });
    r.ctx.close();
    var wav = toWav(r.chunks, 16000);
    if (wav.byteLength < 44 + 16000) { toast("Too short — hold while you speak.", true); return; }
    fetch(u("/voice"), { method: "POST", body: wav }).then(function () { toast("Sent to Echo."); }).catch(function () { toast("Couldn't reach the Mac.", true); });
  }
  function toWav(chunks, rate) {
    var length = chunks.reduce(function (n, c) { return n + c.length; }, 0);
    var buffer = new ArrayBuffer(44 + length * 2);
    var view = new DataView(buffer);
    var str = function (o, s) { for (var i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
    str(0, "RIFF"); view.setUint32(4, 36 + length * 2, true); str(8, "WAVE");
    str(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    str(36, "data"); view.setUint32(40, length * 2, true);
    var o = 44;
    chunks.forEach(function (c) {
      for (var i = 0; i < c.length; i++, o += 2) {
        var s = Math.max(-1, Math.min(1, c[i]));
        view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      }
    });
    return buffer;
  }
  function setTalkUI(on) {
    $("talk").setAttribute("aria-pressed", on ? "true" : "false");
    $("talk-label").textContent = on ? "RELEASE TO SEND" : "HOLD TO TALK";
    if (on) {
      body.setAttribute("data-status", "listening");
      $("state-label").textContent = "LISTENING";
      var hud = $("hud-talk");
      hud.classList.remove("wake");
      void hud.offsetWidth;
      hud.classList.add("wake");
    }
  }
  // Hold the button; or tap the reactor once to start and again to send.
  var talkBtn = $("talk");
  talkBtn.addEventListener("pointerdown", function (e) { e.preventDefault(); talkBtn.setPointerCapture(e.pointerId); startTalk(); });
  talkBtn.addEventListener("pointerup", stopTalk);
  talkBtn.addEventListener("pointercancel", stopTalk);
  talkBtn.addEventListener("contextmenu", function (e) { e.preventDefault(); });
  $("hud-talk").addEventListener("click", function () { if (talking) stopTalk(); else startTalk(); });

  // ---- screen --------------------------------------------------------------
  // Live video is peer to peer. STUN lets it cross most home routers; on
  // mobile data the carrier often blocks it anyway, so if no video arrives
  // within a few seconds the page switches to stills fetched over the same
  // https link as everything else, which work on any network.
  var ICE = [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }];
  var FALLBACK_MS = 7000;
  var pc = null, connected = false, answered = false, fallbackTimer = 0;
  function connectRTC() {
    if (!pc) {
      clearTimeout(fallbackTimer);
      fallbackTimer = setTimeout(function () { if (!videoLive()) startFrames(); }, FALLBACK_MS);
    } else if (!videoLive()) {
      startFrames();
    }
    if (pc) return;
    answered = false;
    pc = new RTCPeerConnection({ iceServers: ICE });
    pc.ontrack = function (ev) {
      if (ev.track.kind === "video") {
        $("screen").srcObject = ev.streams[0];
        $("novid").hidden = true;
        stopFrames();
      } else {
        $("macaudio").srcObject = ev.streams[0];
      }
    };
    pc.onicecandidate = function (ev) {
      if (ev.candidate) request("/rtc/ice", { candidate: ev.candidate }).catch(function () {});
    };
    pc.onconnectionstatechange = function () {
      connected = pc.connectionState === "connected";
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        pc = null;
        // Keep the screen on stills while live video retries in the background.
        if (!$("page-screen").hidden) startFrames();
        setTimeout(function () { if (!$("page-screen").hidden) connectRTC(); }, 15000);
      }
    };
    pc.addTransceiver("audio", { direction: "recvonly" });
    pc.addTransceiver("video", { direction: "recvonly" });
    pc.createOffer()
      .then(function (offer) { return pc.setLocalDescription(offer); })
      .then(function () { return request("/rtc/offer", { sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } }); })
      .then(pollAnswer)
      .catch(function () {});
  }
  function pollAnswer() {
    if (!pc) return;
    request("/rtc/answer").then(function (d) {
      if (d.answer && !answered) { answered = true; pc.setRemoteDescription(d.answer); }
      (d.ice || []).forEach(function (c) { pc.addIceCandidate(c).catch(function () {}); });
    }).catch(function () {}).then(function () { if (pc && !connected) setTimeout(pollAnswer, 1000); });
  }
  $("screen").addEventListener("loadedmetadata", function () {
    var v = $("screen");
    $("res").textContent = v.videoWidth + "×" + v.videoHeight;
  });
  function videoLive() { return connected && $("screen").videoWidth > 0; }

  // Stills: one request at a time, the next as soon as the last has shown,
  // never faster than 2 a second (stills cost mobile data; video does not). They stop when live video arrives or when
  // the Screen page is left, so the Mac is not capturing for nobody.
  var framesOn = false, frameUrl = "", frameBlob = null;
  function startFrames() {
    if (framesOn || $("page-screen").hidden) return;
    framesOn = true;
    $("live-mode").textContent = "SNAPSHOTS";
    nextFrame();
  }
  function stopFrames() {
    framesOn = false;
    $("frame").hidden = true;
    $("live-mode").textContent = "LIVE";
  }
  function nextFrame() {
    if (!framesOn || !sess) return;
    var asked = Date.now();
    fetch(u("/frame")).then(function (r) {
      if (r.status === 401) { signedOut(); throw new Error("signed out"); }
      if (!r.ok) return r.json().then(function (d) { throw new Error(d.error || "no frame"); });
      return r.blob();
    }).then(function (blob) {
      if (!framesOn) return;
      frameBlob = blob;
      var img = $("frame");
      var old = frameUrl;
      frameUrl = URL.createObjectURL(blob);
      img.onload = function () {
        if (old) URL.revokeObjectURL(old);
        $("res").textContent = img.naturalWidth + "×" + img.naturalHeight + " · stills";
      };
      img.src = frameUrl;
      img.hidden = false;
      $("novid").hidden = true;
    }).catch(function (e) {
      $("novid").hidden = false;
      $("novid-sub").textContent = String(e && e.message || "Couldn't get the screen.");
    }).then(function () {
      if (framesOn) setTimeout(nextFrame, Math.max(0, 500 - (Date.now() - asked)));
    });
  }
  $("audio").addEventListener("click", function () {
    var a = $("macaudio");
    a.muted = !a.muted;
    if (!a.muted) a.play().catch(function () {});
    this.setAttribute("aria-pressed", a.muted ? "false" : "true");
    toast(a.muted ? "Mac audio off." : "Mac audio on.");
  });
  $("snap").addEventListener("click", function () {
    var v = $("screen");
    var save = function (blob) {
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "echo-screen-" + new Date().toISOString().slice(0, 19).replace(/:/g, "-") + (blob.type === "image/jpeg" ? ".jpg" : ".png");
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
      toast("Screenshot saved.");
    };
    if (videoLive()) {
      var c = document.createElement("canvas");
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      c.getContext("2d").drawImage(v, 0, 0);
      c.toBlob(save, "image/png");
    } else if (frameBlob) {
      save(frameBlob);
    } else {
      toast("No screen yet.", true);
    }
  });

  function segment(a, b, paneA, paneB) {
    function pick(first) {
      $(a).setAttribute("aria-selected", first ? "true" : "false");
      $(b).setAttribute("aria-selected", first ? "false" : "true");
      $(paneA).hidden = !first;
      $(paneB).hidden = first;
    }
    $(a).addEventListener("click", function () { pick(true); });
    $(b).addEventListener("click", function () { pick(false); });
  }
  segment("tab-pad", "tab-keys", "pane-pad", "pane-keys");
  segment("tab-tasks", "tab-projects", "pane-tasks", "pane-projects");

  // The trackpad: drags become relative moves, batched every 40 ms; a short
  // still touch is a click, and two of them close together a double-click.
  var GAIN = 2.2;
  var pad = $("pad"), touch = null, sendDx = 0, sendDy = 0, flushTimer = 0, lastTap = 0, tapTimer = 0;
  function mouse(action, extra) {
    var payload = { action: action };
    if (extra) for (var k in extra) payload[k] = extra[k];
    return request("/mouse", payload).catch(function () {});
  }
  function flushMove() {
    flushTimer = 0;
    if (!sendDx && !sendDy) return;
    mouse("move", { dx: Math.round(sendDx), dy: Math.round(sendDy) });
    sendDx = sendDy = 0;
  }
  pad.addEventListener("pointerdown", function (e) {
    e.preventDefault();
    pad.setPointerCapture(e.pointerId);
    touch = { x: e.clientX, y: e.clientY, at: Date.now(), moved: 0 };
    pad.classList.add("active");
  });
  pad.addEventListener("pointermove", function (e) {
    if (!touch) return;
    var dx = e.clientX - touch.x, dy = e.clientY - touch.y;
    touch.x = e.clientX;
    touch.y = e.clientY;
    touch.moved += Math.abs(dx) + Math.abs(dy);
    sendDx += dx * GAIN;
    sendDy += dy * GAIN;
    if (!flushTimer) flushTimer = setTimeout(flushMove, 40);
  });
  function endTouch() {
    if (!touch) return;
    var tap = touch.moved < 8 && Date.now() - touch.at < 260;
    touch = null;
    pad.classList.remove("active");
    flushMove();
    if (!tap) return;
    var now = Date.now();
    if (now - lastTap < 300) {
      clearTimeout(tapTimer);
      lastTap = 0;
      mouse("dclick");
    } else {
      lastTap = now;
      tapTimer = setTimeout(function () { mouse("click"); }, 300);
    }
  }
  pad.addEventListener("pointerup", endTouch);
  pad.addEventListener("pointercancel", endTouch);
  document.querySelectorAll("[data-mouse]").forEach(function (b) {
    b.addEventListener("click", function () { mouse(b.getAttribute("data-mouse")); });
  });
  document.querySelectorAll("[data-key]").forEach(function (b) {
    b.addEventListener("click", function () {
      request("/keys", { key: b.getAttribute("data-key") }).then(function (d) {
        if (d.ok === false) toast("The Mac didn't take that key.", true);
      }).catch(function () { toast("Couldn't reach the Mac.", true); });
    });
  });
  $("type-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var text = $("type-text").value;
    if (!text) { toast("Type something first.", true); return; }
    request("/keys", { text: text }).then(function (d) {
      if (d.ok === false) { toast(d.reason || "The Mac didn't take that.", true); return; }
      $("type-text").value = "";
      toast("Typed on the Mac.");
    }).catch(function () { toast("Couldn't reach the Mac.", true); });
  });

  // ---- work ----------------------------------------------------------------
  var PHASE_COLOR = { completed: "var(--green)", implementing: "var(--cyan)", building: "var(--cyan)", verifying: "var(--cyan)" };
  var STATUS_TEXT = { running: "RUNNING", done: "DONE", completed: "DONE", failed: "FAILED", cancelled: "STOPPED", stopped: "STOPPED", blocked: "BLOCKED" };
  var armed = "";
  function renderWork(d) {
    var missions = d.missions || [];
    $("n-tasks").textContent = missions.filter(function (m) { return m.status === "running"; }).length;
    var box = $("missions");
    clear(box);
    $("missions-empty").hidden = missions.length > 0;
    missions.forEach(function (m) {
      var running = m.status === "running";
      var card = el("section", "mission");
      var head = el("div", "mission-head");
      var top = el("div", "card-head");
      var st = el("span", "eyebrow", (STATUS_TEXT[m.status] || String(m.status).toUpperCase()) + (running && m.id.indexOf("supervised.") === 0 ? " · SUPERVISED" : ""));
      st.style.color = running ? "var(--green)" : m.status === "failed" ? "var(--red)" : "var(--muted)";
      top.appendChild(st);
      top.appendChild(el("span", "mono small muted", span(((running ? Date.now() : m.updatedAt) - m.createdAt) / 1000)));
      head.appendChild(top);
      head.appendChild(el("p", "card-title", m.goal));
      card.appendChild(head);
      if (m.steps && m.steps.length) {
        var ol = el("ol", "steps");
        m.steps.forEach(function (s) {
          var li = el("li");
          li.appendChild(el("span", "step-dot " + s.status));
          li.appendChild(el("span", "step-label", s.goal));
          li.appendChild(el("span", "mono tiny muted", s.actor || s.status));
          ol.appendChild(li);
        });
        card.appendChild(ol);
      }
      if (running) {
        var foot = el("div", "mission-foot");
        var stop = el("button", armed === m.id ? "armed" : "", armed === m.id ? "TAP AGAIN TO STOP" : "STOP TASK");
        stop.type = "button";
        stop.addEventListener("click", function () {
          if (armed !== m.id) {
            armed = m.id;
            stop.className = "armed";
            stop.textContent = "TAP AGAIN TO STOP";
            setTimeout(function () { if (armed === m.id) { armed = ""; stop.className = ""; stop.textContent = "STOP TASK"; } }, 3000);
            return;
          }
          armed = "";
          stop.textContent = "STOPPING…";
          request("/action", { type: "stop-mission", missionId: m.id }).then(function (r) {
            toast(r.message || (r.ok ? "Stopped." : "Couldn't stop it."), !r.ok);
          }).catch(function () { toast("Couldn't reach the Mac.", true); });
        });
        foot.appendChild(stop);
        card.appendChild(foot);
      }
      box.appendChild(card);
    });

    var turns = $("turns");
    clear(turns);
    (d.tasks || []).slice().reverse().forEach(function (t) {
      var row = el("li", "row-item");
      var left = el("div");
      left.appendChild(el("div", "name", t.title));
      left.appendChild(el("div", "mono tiny muted", clock(t.startedAt) + (t.finishedAt ? " · " + span((t.finishedAt - t.startedAt) / 1000) : "")));
      var badge = el("span", "badge", (STATUS_TEXT[t.status] || t.status).toUpperCase());
      badge.style.color = t.status === "done" ? "var(--green)" : t.status === "working" ? "var(--cyan)" : t.status === "failed" ? "var(--red)" : "var(--muted)";
      row.appendChild(left);
      row.appendChild(badge);
      turns.appendChild(row);
    });
    projects = d.projects || [];
    $("n-projects").textContent = projects.length;
    renderProjects();
  }

  var projects = [], pfilter = "all", openProject = "";
  function renderProjects() {
    var box = $("projects");
    clear(box);
    var shown = projects.filter(function (p) {
      return pfilter === "all" || (pfilter === "done" ? p.phase === "completed" : p.phase !== "completed");
    });
    $("projects-empty").hidden = shown.length > 0;
    shown.forEach(function (p) {
      var open = openProject === p.id;
      var card = el("div", "project");
      card.setAttribute("open-state", open ? "true" : "false");
      var btn = el("button");
      btn.type = "button";
      btn.setAttribute("aria-expanded", open ? "true" : "false");
      var left = el("span");
      left.appendChild(el("span", "name", p.name));
      left.appendChild(el("span", "mono tiny muted", "rev " + p.revision + " · " + p.criteria + " criteria · " + new Date(p.updatedAt).toLocaleDateString([], { month: "short", day: "numeric" })));
      var badge = el("span", "badge", String(p.phase).toUpperCase());
      badge.style.color = PHASE_COLOR[p.phase] || "var(--copper)";
      btn.appendChild(left);
      btn.appendChild(badge);
      btn.addEventListener("click", function () { openProject = open ? "" : p.id; renderProjects(); });
      card.appendChild(btn);
      if (open) {
        if (p.question) card.appendChild(el("p", "q", "Echo asks: " + p.question));
        var row = el("div", "row2");
        var preview = el("button", "btn", "PREVIEW");
        var go = el("button", "btn btn-ghost", p.phase === "completed" ? "RUN CHECKS" : "RESUME BUILD");
        preview.type = go.type = "button";
        // These go through Echo like anything you say, so the same safety
        // checks apply; the phone gets no project access of its own.
        preview.addEventListener("click", function () { sendCommand("Show me the preview of the project \"" + p.name + "\".", "typed").then(function () { toast("Asked Echo for the preview."); }); });
        go.addEventListener("click", function () {
          var ask = p.phase === "completed" ? "Run the checks for the project \"" + p.name + "\"." : "Continue building the project \"" + p.name + "\".";
          sendCommand(ask, "typed").then(function () { toast("Sent to Echo."); });
        });
        row.appendChild(preview);
        row.appendChild(go);
        card.appendChild(row);
      }
      box.appendChild(card);
    });
  }
  document.querySelectorAll("[data-pfilter]").forEach(function (b) {
    b.addEventListener("click", function () {
      pfilter = b.getAttribute("data-pfilter");
      document.querySelectorAll("[data-pfilter]").forEach(function (x) { x.setAttribute("aria-pressed", x === b ? "true" : "false"); });
      renderProjects();
    });
  });

  // ---- feed ----------------------------------------------------------------
  var feedRows = [], ffilter = "all";
  var WHO = { you: "YOU", echo: "ECHO", tool: "TOOL", alert: "ALERT" };
  function kindOf(k) {
    if (k === "user") return "you";
    if (k === "assistant") return "echo";
    if (k === "error" || k === "warn" || k === "stop") return "alert";
    return "tool";
  }
  function renderFeedLogs(logs) {
    if (!logs.length) return;
    logs.forEach(function (l) {
      logsAfter = Math.max(logsAfter, l.id);
      // Echo marks phone and Telegram commands with an emoji for the desk; the
      // feed already says YOU, and the emoji has no glyph in the phone's font.
      feedRows.push({ at: l.at, kind: kindOf(l.kind), text: String(l.text).replace(/^(?:\uD83D\uDCF1|\u2708\uFE0F?)\s*/, "") });
    });
    trimFeed();
  }
  function trimFeed() {
    if (feedRows.length > 200) feedRows.splice(0, feedRows.length - 200);
    drawFeed();
  }
  function drawFeed() {
    var list = $("feed");
    clear(list);
    var rows = feedRows.filter(function (r) { return ffilter === "all" || r.kind === ffilter; });
    $("feed-empty").hidden = rows.length > 0;
    rows.slice(-120).reverse().forEach(function (r) {
      var li = el("li", r.kind);
      li.appendChild(el("time", "", clock(r.at)));
      li.appendChild(el("span", "rule"));
      var text = el("span", "text");
      text.appendChild(el("span", "who", WHO[r.kind]));
      text.appendChild(document.createTextNode(r.text));
      li.appendChild(text);
      list.appendChild(li);
    });
  }
  document.querySelectorAll("[data-ffilter]").forEach(function (b) {
    b.addEventListener("click", function () {
      ffilter = b.getAttribute("data-ffilter");
      document.querySelectorAll("[data-ffilter]").forEach(function (x) { x.setAttribute("aria-pressed", x === b ? "true" : "false"); });
      drawFeed();
    });
  });
  // The remote's own events (a phone signed in, a stop from the phone). The
  // phone's commands are already in the main log, so they are not repeated.
  // Echo's answers to what was asked from a phone arrive here as "reply"
  // events: shown on Core and read out by the phone itself, because the Mac
  // stays quiet for turns that did not start there.
  var eventsNext = 0, firstEvents = true;
  function pollEvents() {
    request("/events?since=" + eventsNext).then(function (d) {
      if (!d || !d.items) return;
      eventsNext = d.nextIndex;
      var added = false;
      d.items.forEach(function (it) {
        var line = String(it.line);
        if (it.kind === "reply") {
          // Old replies from before this page loaded are not read out.
          if (!firstEvents) sayHere(line.replace(/^Echo:\s*/, ""));
          return;
        }
        // Echo's words, actions and the phone's own commands are already in
        // the main log; only the remote's own events are added here.
        if (it.kind === "jarvis" || it.kind === "action" || line.indexOf("You (phone)") === 0) return;
        feedRows.push({ at: it.at, kind: it.kind === "stop" ? "alert" : "tool", text: line });
        added = true;
      });
      firstEvents = false;
      if (added) trimFeed();
    }).catch(function () {}).then(function () { if (sess) setTimeout(pollEvents, document.hidden ? 5000 : 1200); });
  }

  // Reading replies aloud on the phone. iOS only lets a page speak after a
  // touch, so the first touch anywhere unlocks it with a silent utterance.
  var speakHere = store("echo_speak") !== "off";
  var synth = window.speechSynthesis || null;
  function renderSpeakSwitch() { $("speak-here").setAttribute("aria-checked", speakHere ? "true" : "false"); }
  renderSpeakSwitch();
  $("speak-here").addEventListener("click", function () {
    speakHere = !speakHere;
    store("echo_speak", speakHere ? "on" : "off");
    renderSpeakSwitch();
    if (!speakHere && synth) synth.cancel();
  });
  document.addEventListener("pointerdown", function unlock() {
    document.removeEventListener("pointerdown", unlock);
    if (synth) { try { synth.speak(new SpeechSynthesisUtterance("")); } catch (e) {} }
  });
  var replyTimer = 0;
  function sayHere(text) {
    if (!text) return;
    var line = $("reply-line");
    line.textContent = text;
    line.hidden = false;
    clearTimeout(replyTimer);
    replyTimer = setTimeout(function () { line.hidden = true; }, 20000);
    if (!speakHere || !synth) return;
    var u = new SpeechSynthesisUtterance(text);
    u.rate = 1.02;
    var voices = synth.getVoices().filter(function (v) { return /^en/i.test(v.lang); });
    var pick = voices.filter(function (v) { return /Daniel|Arthur|Samantha|Karen/i.test(v.name); })[0] || voices[0];
    if (pick) u.voice = pick;
    u.onstart = function () { body.setAttribute("data-status", "speaking"); $("state-label").textContent = STATE_LABEL.speaking; };
    synth.speak(u);
  }

  // ---- system --------------------------------------------------------------
  var switching = "";
  function renderSystem(d) {
    var box = $("brains");
    clear(box);
    (d.models || []).forEach(function (m) {
      var b = el("button", "radio" + (switching === m.id ? " busy" : ""));
      b.type = "button";
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", m.active ? "true" : "false");
      b.appendChild(el("span", "ring"));
      var label = el("span", "label");
      label.appendChild(el("b", "", m.label));
      label.appendChild(el("span", "mono tiny muted", m.model));
      b.appendChild(label);
      b.appendChild(el("span", "note", m.active ? "ACTIVE" : switching === m.id ? "SWITCHING…" : ""));
      b.addEventListener("click", function () {
        if (m.active || switching) return;
        switching = m.id;
        render(last);
        request("/action", { type: "switch-model", provider: m.id }).then(function (r) {
          toast(r.message || (r.ok ? "Switched to " + m.label + "." : "Couldn't switch."), !r.ok);
        }).catch(function () { toast("Couldn't reach the Mac.", true); }).then(function () { switching = ""; });
      });
      box.appendChild(b);
    });
    var v = d.voice || {};
    document.querySelectorAll("[data-voice]").forEach(function (s) {
      s.setAttribute("aria-checked", v[s.getAttribute("data-voice")] ? "true" : "false");
    });
    var conns = $("connections");
    clear(conns);
    (d.connections || []).forEach(function (c) {
      var row = el("div", "conn");
      row.appendChild(el("span", "", c.name));
      var s = el("span", "badge", c.status === "active" ? "ACTIVE" : "CONFIGURED");
      s.style.color = c.status === "active" ? "var(--green)" : "var(--muted)";
      row.appendChild(s);
      conns.appendChild(row);
    });
    if (!(d.connections || []).length) conns.appendChild(el("div", "conn muted", "No MCP servers configured."));
  }
  document.querySelectorAll("[data-voice]").forEach(function (s) {
    s.addEventListener("click", function () {
      var key = s.getAttribute("data-voice");
      var value = s.getAttribute("aria-checked") !== "true";
      s.setAttribute("aria-checked", value ? "true" : "false");
      request("/action", { type: "set-voice", key: key, value: value }).then(function (r) {
        if (!r.ok) { s.setAttribute("aria-checked", value ? "false" : "true"); toast(r.message || "Couldn't change that.", true); }
      }).catch(function () { toast("Couldn't reach the Mac.", true); });
    });
  });
  $("signout-all").addEventListener("click", function () {
    if (!confirm("Sign out every phone, including this one?")) return;
    request("/signout-all", {}).catch(function () {}).then(signedOut);
  });
  var closeArmed = false;
  $("close-remote").addEventListener("click", function () {
    var b = this;
    if (!closeArmed) {
      closeArmed = true;
      b.textContent = "TAP AGAIN TO CLOSE";
      setTimeout(function () { closeArmed = false; b.textContent = "CLOSE REMOTE"; }, 3000);
      return;
    }
    request("/close", {}).then(function () {
      toast("Remote closed. Reopen it from the Mac.");
      body.setAttribute("data-link", "down");
    }).catch(function () {});
  });

  if (sess) enter();
})();
