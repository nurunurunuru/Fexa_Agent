/**
 * widget.js — Embeddable Realtime Voice Agent Widget
 *
 * UI:
 * - Green/black gradient
 * - Name / Phone / Email form
 * - Phone-style Start Call button
 * - Voice Call launcher
 * - Messaging launcher beside Voice Call
 *
 * Existing functionality:
 * - WebSocket
 * - Realtime voice
 * - Microphone streaming
 * - AI audio playback
 * - User transcript
 * - AI transcript
 * - VAD
 */

(function () {
  "use strict";

  // ============================================================
  // CONFIG System
  // ============================================================

  var scriptTag = document.currentScript;

  var AGENT_ID =
    scriptTag.getAttribute("data-agent-id");

  var SERVER =
    (scriptTag.getAttribute("data-server") || "")
      .replace(/\/$/, "");

  var PRIMARY_COLOR =
    scriptTag.getAttribute("data-color") ||
    "#00d9a0";

  var AGENT_NAME =
    scriptTag.getAttribute("data-name") ||
    "Fexa Agents";

  var AGENT_AVATAR =
    scriptTag.getAttribute("data-avatar") || "";

  if (!AGENT_ID || !SERVER) {
    console.error(
      "[voice-agent] data-agent-id বা data-server missing"
    );
    return;
  }

  var WS_BASE =
    SERVER.replace(/^http/, "ws") +
    "/ws/voice?agentId=" +
    encodeURIComponent(AGENT_ID);


  // ============================================================
  // STYLE System
  // ============================================================

  var style = document.createElement("style");

  style.textContent = `

    /* ==========================================================
       GLOBAL
    ========================================================== */

    #va-launcher,
    #va-messaging-wrapper,
    #va-panel {
      font-family:
        system-ui,
        -apple-system,
        BlinkMacSystemFont,
        "Segoe UI",
        Roboto,
        Arial,
        sans-serif;
      box-sizing: border-box;
    }

    #va-launcher *,
    #va-messaging-wrapper *,
    #va-panel * {
      box-sizing: border-box;
    }


    /* ==========================================================
       BOTTOM VOICE CALL LAUNCHER
    ========================================================== */

    #va-launcher {
      position: fixed;
      right: 24px;
      bottom: 4px;

      width: 236px;
      height: 60px;

      z-index: 999999;

      display: flex;
      align-items: center;

      padding: 5px;

      border-radius: 999px;

      background:
        linear-gradient(
          100deg,
           #073d32 0%,
          #02231c 43%,
          #00130f 100%
        );

      box-shadow:
        0 10px 35px rgba(70, 35, 150, .35),
        0 4px 12px rgba(0, 0, 0, .15);

      transition:
        transform .2s ease,
        box-shadow .2s ease;
    }

    #va-launcher:hover {
      transform: translateY(-2px);

      box-shadow:
        0 13px 40px rgba(70, 35, 150, .42),
        0 5px 15px rgba(0, 0, 0, .16);
    }


    /* microphone circle */

    #va-launcher-icon {
      width: 50px;
      height: 50px;

      flex: 0 0 50px;

      display: flex;
      align-items: center;
      justify-content: center;

      border-radius: 50%;

      background:
        rgba(255,255,255,.10);

      color: #fff;
    }

    #va-launcher-icon svg {
      width: 24px;
      height: 24px;

      fill: none;
      stroke: currentColor;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }


    /* voice call button */

    #va-bubble {
      flex: 1;

      height: 50px;

      border: none;
      border-radius: 999px;

      background: #fff;

      color: #211b40;

      display: flex;
      align-items: center;
      justify-content: center;

      gap: 9px;

      cursor: pointer;

      font-family: inherit;
      font-size: 16px;
      font-weight: 800;

      padding: 0 18px;

      box-shadow:
        0 2px 8px rgba(0,0,0,.12);
    }

    #va-bubble:hover {
      background: #faf9ff;
    }

    #va-bubble svg {
      width: 21px;
      height: 21px;

      fill: none;
      stroke: currentColor;
      stroke-width: 2.2;
      stroke-linecap: round;
      stroke-linejoin: round;

      flex-shrink: 0;
    }


    /* ==========================================================
       MESSAGING BUTTON
    ========================================================== */

    #va-messaging-wrapper {
      position: fixed;

      right: 272px;
      bottom: 4px;

      z-index: 999999;
    }

    #va-message-btn {
      position: relative;

      width: 60px;
      height: 60px;

      border: none;
      border-radius: 50%;

      background:
        linear-gradient(
          135deg,
           #073d32 0%,
           #02231c 43%,
           #00130f 100%
        );

      color: #fff;

      display: flex;
      align-items: center;
      justify-content: center;

      cursor: pointer;

      box-shadow:
        0 8px 25px rgba(89,44,175,.32);

      transition:
        transform .2s ease;
    }

    #va-message-btn:hover {
      transform: translateY(-2px) scale(1.03);
    }

    #va-message-btn svg {
      width: 27px;
      height: 27px;

      fill: none;
      stroke: currentColor;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }


    /* message badge */

    #va-message-badge {
      position: absolute;

      right: -2px;
      top: -4px;

      min-width: 22px;
      height: 22px;

      padding: 0 5px;

      display: flex;
      align-items: center;
      justify-content: center;

      border-radius: 50%;

      background: #ff4646;

      color: #fff;

      border: 2px solid #fff;

      font-size: 11px;
      font-weight: 800;
    }


    /* messaging menu */

    #va-message-menu {
      position: absolute;

      right: 0;
      bottom: 72px;

      width: 230px;

      padding: 8px;

      display: none;
      flex-direction: column;

      gap: 3px;

      background: #fff;

      border:
        1px solid #eeeeee;

      border-radius: 16px;

      box-shadow:
        0 15px 45px rgba(0,0,0,.20);
    }

    #va-message-menu.open {
      display: flex;
    }

    #va-message-menu a {
      display: flex;
      align-items: center;

      gap: 10px;

      padding: 11px 12px;

      border-radius: 10px;

      text-decoration: none;

      color: #222;

      font-size: 13px;
      font-weight: 600;

      transition:
        background .15s ease;
    }

    #va-message-menu a:hover {
      background: #f3f4f6;
    }

    #va-message-menu a span {
      width: 25px;

      text-align: center;

      font-size: 18px;
    }


    /* ==========================================================
       MAIN CALL PANEL
    ========================================================== */

    #va-panel {
      position: fixed;

      right: 24px;
      bottom: 70px;

      width: 420px;

      height:
        min(
          650px,
          calc(100dvh - 120px)
        );

      max-width:
        calc(100vw - 32px);

      min-height: 480px;

      z-index: 1000000;

      display: none;
      flex-direction: column;

      overflow: hidden;

      border-radius: 30px;

      color: #fff;

      background:

        radial-gradient(
          circle at 8% 8%,
          rgba(0,255,184,.30),
          transparent 34%
        ),

        radial-gradient(
          circle at 100% 100%,
          rgba(0,255,170,.34),
          transparent 40%
        ),

        linear-gradient(
          145deg,
          #073d32 0%,
          #02231c 43%,
          #00130f 100%
        );

      border:
        1px solid rgba(255,255,255,.13);

      box-shadow:
        0 25px 80px rgba(0,0,0,.45),
        inset 0 0 80px rgba(0,255,184,.04);
    }

    #va-panel.open {
      display: flex;

      animation:
        va-panel-in .25s ease both;
    }

    @keyframes va-panel-in {

      from {
        opacity: 0;
        transform:
          translateY(14px)
          scale(.98);
      }

      to {
        opacity: 1;
        transform:
          translateY(0)
          scale(1);
      }

    }


    /* ==========================================================
       HEADER
    ========================================================== */

    #va-header {
      position: relative;

      flex-shrink: 0;

      display: flex;
      flex-direction: column;

      align-items: center;

      padding:
        18px
        20px
        0;
    }


    /* close */

    #va-close {
      position: absolute;

      right: 18px;
      top: 18px;

      width: 43px;
      height: 43px;

      border-radius: 50%;

      border:
        1px solid rgba(255,255,255,.28);

      background:
        rgba(255,255,255,.035);

      color: #fff;

      display: flex;
      align-items: center;
      justify-content: center;

      cursor: pointer;

      font-size: 29px;
      font-weight: 200;
      line-height: 1;
    }


    /* sound */

    #va-sound-btn {
      position: absolute;

      left: 18px;
      top: 18px;

      width: 43px;
      height: 43px;

      border-radius: 50%;

      border:
        1px solid rgba(255,255,255,.28);

      background:
        rgba(255,255,255,.035);

      color: #fff;

      display: flex;
      align-items: center;
      justify-content: center;

      cursor: pointer;
    }

    #va-sound-btn svg {
      width: 22px;
      height: 22px;

      fill: currentColor;
    }


    /* transcript / messages toggle */

    #va-transcript-btn {
      position: absolute;

      left: 71px;
      top: 18px;

      width: 43px;
      height: 43px;

      border-radius: 50%;

      border:
        1px solid rgba(255,255,255,.28);

      background:
        rgba(255,255,255,.035);

      color: #fff;

      display: flex;
      align-items: center;
      justify-content: center;

      cursor: pointer;
    }

    #va-transcript-btn svg {
      width: 20px;
      height: 20px;

      fill: none;
      stroke: currentColor;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }

    #va-transcript-btn.active {
      background:
        rgba(29,209,161,.25);

      border-color:
        rgba(29,209,161,.6);
    }


    /* ==========================================================
       AVATAR
    ========================================================== */

    #va-avatar {
      width: 75px;
      height: 75px;

      margin-top: 18px;

      padding: 3px;

      border-radius: 50%;

      background:
        linear-gradient(
          135deg,
          #00f5b0,
          #00e5a4,
          #00c890
        );

      box-shadow:
        0 0 0 2px
          rgba(0,255,180,.10),

        0 0 35px
          rgba(0,255,177,.25);
    }

    #va-avatar-inner {
      width: 100%;
      height: 100%;

      border-radius: 50%;

      overflow: hidden;

      display: flex;
      align-items: center;
      justify-content: center;

      background:
        linear-gradient(
          145deg,
          #dce9e5,
          #7fa99f
        );
    }

    #va-avatar img {
      width: 100%;
      height: 100%;

      object-fit: cover;

      display: block;
    }

    #va-avatar-placeholder svg {
      width: 62px;
      height: 62px;

      fill:
        rgba(0,50,42,.72);
    }


    /* ==========================================================
       TITLE
    ========================================================== */

    #va-title {
      margin-top: 12px;

      font-size: 22px;

      line-height: 1.15;

      font-weight: 800;

      letter-spacing: -.8px;

      text-align: center;
    }

    #va-title .brand {
      color: #00edb0;
    }

    #va-title .support {
      color: #fff;
    }

    #va-subtitle {
      margin-top: 8px;

      color:
        rgba(255,255,255,.70);

      font-size: 15px;

      text-align: center;
    }


    /* ==========================================================
       CUSTOMER FORM
    ========================================================== */

    #va-user-form {
      width: 100%;

      padding:
        6px
        10px
        0;

      display: flex;
      flex-direction: column;

      gap: 12px;

      flex-shrink: 0;
    }

    .va-input {
      width: 100%;

      height: 53px;

      padding:
        0 20px;

      border-radius: 999px;

      border:
        1px solid
        rgba(255,255,255,.20);

      outline: none;

      background:
        rgba(255,255,255,.075);

      color: #fff;

      font-family: inherit;

      font-size: 15px;

      transition:
        border .2s ease,
        background .2s ease,
        box-shadow .2s ease;
    }

    .va-input::placeholder {
      color:
        rgba(255,255,255,.60);
    }

    .va-input:focus {
      border-color:
        rgba(0,240,178,.75);

      background:
        rgba(255,255,255,.10);

      box-shadow:
        0 0 0 3px
        rgba(0,240,178,.08);
    }

    .va-input.va-invalid {
      border-color:
        rgba(255,85,85,.90);

      box-shadow:
        0 0 0 3px
        rgba(255,85,85,.08);
    }


    /* ==========================================================
       CHAT
    ========================================================== */

    #va-chat {
      display: none;

      flex: 1;

      min-height: 0;

      overflow-y: auto;

      padding:
        15px
        20px;

      flex-direction: column;

      gap: 9px;

      scroll-behavior: smooth;
    }

    #va-panel.in-call #va-user-form {
      display: none;
    }

    #va-panel.show-transcript #va-chat {
      display: flex;
    }

    #va-chat::-webkit-scrollbar {
      width: 4px;
    }

    #va-chat::-webkit-scrollbar-thumb {
      background:
        rgba(255,255,255,.18);

      border-radius: 10px;
    }


    /* messages */

    .va-message {
      display: flex;

      width: 100%;

      margin-bottom: 2px;
    }

    .va-message.user {
      justify-content: flex-end;
    }

    .va-message.assistant {
      justify-content: flex-start;
    }

    .va-bubble-msg {
      max-width: 84%;

      padding:
        9px
        12px;

      border-radius: 13px;

      font-size: 13px;

      line-height: 1.55;

      white-space: pre-wrap;

      overflow-wrap: break-word;

      text-align: left;
    }

    .va-message.user .va-bubble-msg {
      background:
        rgba(0,235,174,.90);

      color: #00261d;

      border-bottom-right-radius: 4px;
    }

    .va-message.assistant .va-bubble-msg {
      background:
        rgba(255,255,255,.08);

      color: #fff;

      border:
        1px solid
        rgba(255,255,255,.11);

      border-bottom-left-radius: 4px;
    }

    .va-label {
      font-size: 9px;

      font-weight: 700;

      opacity: .62;

      margin-bottom: 3px;
    }

    .va-empty {
      margin: auto;

      text-align: center;

      color:
        rgba(255,255,255,.48);

      font-size: 13px;

      padding: 20px;
    }


    /* ==========================================================
       CONTROL
    ========================================================== */

    #va-control {
      flex-shrink: 0;

      margin-top: auto;

      padding:
        12px
        24px
        13px;

      display: flex;

      flex-direction: column;

      align-items: center;

      gap: 8px;
    }

    #va-status {
      min-height: 17px;

      color:
        rgba(255,255,255,.70);

      font-size: 12px;

      text-align: center;
    }

    #va-call-row {
      width: 100%;

      display: flex;

      align-items: center;

      justify-content: center;

      gap: 12px;
    }


    /* microphone */

    #va-orb {
      width: 51px;
      height: 51px;

      flex:
        0 0 51px;

      border-radius: 50%;

      border:
        1px solid
        rgba(255,255,255,.20);

      background:
        rgba(255,255,255,.09);

      display: flex;

      align-items: center;
      justify-content: center;

      transition:
        box-shadow .15s ease,
        background .15s ease;
    }

    #va-orb svg {
      width: 24px;
      height: 24px;

      fill: #fff;
    }

    #va-orb.listening {
      background:
        rgba(0,239,175,.17);

      box-shadow:
        0 0 0 6px
        rgba(0,239,175,.11);
    }

    #va-orb.speaking {
      background:
        rgba(0,239,175,.20);

      box-shadow:
        0 0 0 7px
        rgba(0,239,175,.16);

      animation:
        va-pulse 1s infinite;
    }

    @keyframes va-pulse {

      0%,
      100% {
        box-shadow:
          0 0 0 3px
          rgba(0,239,175,.20);
      }

      50% {
        box-shadow:
          0 0 0 12px
          rgba(0,239,175,.04);
      }

    }


    /* start call */

    #va-mic-btn {
      flex: 1;

      height: 51px;

      border-radius: 999px;

      border:
        1px solid
        rgba(0,255,184,.60);

      background:
        linear-gradient(
          90deg,
          #00bd89,
          #00edb0
        );

      color: #002b21;

      padding:
        0 22px;

      font-family: inherit;

      font-size: 16px;

      font-weight: 800;

      cursor: pointer;

      box-shadow:
        0 0 20px
        rgba(0,235,174,.20);

      display: flex;

      align-items: center;
      justify-content: center;

      gap: 8px;
    }

    #va-mic-btn:hover {
      filter: brightness(1.04);
    }

    #va-mic-btn:disabled {
      opacity: .55;

      cursor: not-allowed;
    }


    /* ==========================================================
       FOOTER
    ========================================================== */

    #va-footer {
      flex-shrink: 0;

      padding:
        0
        10px
        16px;

      text-align: center;

      color:
        rgba(255,255,255,.48);

      font-size: 10px;
    }


    /* ==========================================================
       MOBILE
    ========================================================== */

    @media (max-width: 600px) {

      #va-launcher {
        right: 14px;
        bottom: 14px;

        width: 220px;
        height: 56px;
      }

      #va-launcher-icon {
        width: 46px;
        height: 46px;

        flex-basis: 46px;
      }

      #va-bubble {
        height: 46px;

        font-size: 14px;

        padding:
          0 15px;
      }

      #va-messaging-wrapper {
        right: 244px;
        bottom: 14px;
      }

      #va-message-btn {
        width: 56px;
        height: 56px;
      }

      #va-message-menu {
        bottom: 67px;
      }

      #va-panel {
        left: 10px;
        right: 10px;

        bottom: 78px;

        width: auto;

        max-width: none;

        height:
          calc(100dvh - 92px);

        min-height: 0;

        border-radius: 25px;
      }

      #va-header {
        padding-top: 15px;
      }

      #va-avatar {
        width: 92px;
        height: 92px;

        margin-top: 13px;
      }

      #va-title {
        font-size: 23px;
      }

      #va-subtitle {
        font-size: 14px;
      }

      #va-user-form {
        padding:
          16px
          16px
          0;
      }

      .va-input {
        height: 50px;
      }

      #va-control {
        padding:
          11px
          16px
          10px;
      }

      #va-footer {
        padding-bottom: 12px;
      }

    }


    @media (max-width: 390px) {

      #va-launcher {
        right: 10px;

        width: 205px;
      }

      #va-launcher-icon {
        display: none;
      }

      #va-bubble {
        width: 100%;
      }

      #va-messaging-wrapper {
        right: 225px;
      }

      #va-message-btn {
        width: 54px;
        height: 54px;
      }

      #va-title {
        font-size: 21px;
      }

    }

  `;

  document.head.appendChild(style);


  // ============================================================
  // VOICE LAUNCHER
  // ============================================================

  var launcher =
    document.createElement("div");

  launcher.id = "va-launcher";

  launcher.innerHTML =

    '<div id="va-launcher-icon">' +

      '<svg viewBox="0 0 24 24">' +

        '<path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3z"/>' +

        '<path d="M19 11a7 7 0 0 1-14 0"/>' +

        '<path d="M12 18v3"/>' +

      '</svg>' +

    '</div>' +

    '<button id="va-bubble" type="button">' +

      '<svg viewBox="0 0 24 24">' +

        '<path d="M22 16.92v3a2 2 0 0 1-2.18 2' +
        ' 19.79 19.79 0 0 1-8.63-3.07' +
        ' 19.5 19.5 0 0 1-6-6' +
        ' 19.79 19.79 0 0 1-3.07-8.67' +
        'A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72' +
        ' 12.84 12.84 0 0 0 .7 2.81' +
        ' 2 2 0 0 1-.45 2.11L8.09 9.91' +
        'a16 16 0 0 0 6 6l1.27-1.27' +
        'a2 2 0 0 1 2.11-.45' +
        ' 12.84 12.84 0 0 0 2.81.7' +
        'A2 2 0 0 1 22 16.92z"/>' +

      '</svg>' +

      '<span>Voice Call</span>' +

    '</button>';

  document.body.appendChild(
    launcher
  );

  var bubble =
    launcher.querySelector(
      "#va-bubble"
    );


  // ============================================================
  // MESSAGING System
  // ============================================================

  var messagingWrapper =
    document.createElement("div");

  messagingWrapper.id =
    "va-messaging-wrapper";

  messagingWrapper.innerHTML =

    '<button id="va-message-btn" type="button">' +

      '<svg viewBox="0 0 24 24">' +

        '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8' +
        ' 8.5 8.5 0 0 1-7.6 4.7' +
        ' 8.38 8.38 0 0 1-3.8-.9' +
        'L3 21l1.9-5.7' +
        'A8.38 8.38 0 0 1 4 11.5' +
        ' 8.5 8.5 0 0 1 8.7 3.9' +
        ' 8.38 8.38 0 0 1 12.5 3' +
        'h.5a8.5 8.5 0 0 1 8 8z"/>' +

      '</svg>' +

      '<span id="va-message-badge">1</span>' +

    '</button>' +

    '<div id="va-message-menu">' +

      '<a href="https://wa.me/" target="_blank" rel="noopener noreferrer">' +
        '<span>💬</span> WhatsApp' +
      '</a>' +

      '<a href="https://www.facebook.com/amin.faysal.754" target="_blank" rel="noopener noreferrer">' +
        '<span>🔵</span> Facebook Messenger' +
      '</a>' +

      '<a href="https://www.instagram.com/" target="_blank" rel="noopener noreferrer">' +
        '<span>📷</span> Instagram' +
      '</a>' +

      '<a href="https://mail.google.com/mail/?view=cm" target="_blank" rel="noopener noreferrer">' +
        '<span>📧</span> Gmail' +
      '</a>' +

    '</div>';

  document.body.appendChild(
    messagingWrapper
  );


  var messageBtn =
    messagingWrapper.querySelector(
      "#va-message-btn"
    );

  var messageMenu =
    messagingWrapper.querySelector(
      "#va-message-menu"
    );


  messageBtn.addEventListener(
    "click",
    function (event) {

      event.stopPropagation();

      messageMenu.classList.toggle(
        "open"
      );

    }
  );


  document.addEventListener(
    "click",
    function () {

      messageMenu.classList.remove(
        "open"
      );

    }
  );


  messageMenu.addEventListener(
    "click",
    function (event) {

      event.stopPropagation();

    }
  );


  // ============================================================
  // PANEL System
  // ============================================================

  var panel =
    document.createElement("div");

  panel.id = "va-panel";


  var avatarHTML = "";

  if (AGENT_AVATAR) {

    avatarHTML =
      '<img src="' +
      AGENT_AVATAR +
      '" alt="Agent">';

  } else {

    avatarHTML =

      '<div id="va-avatar-placeholder">' +

        '<svg viewBox="0 0 24 24">' +

          '<path d="M12 12a5 5 0 1 0 0-10' +
          ' 5 5 0 0 0 0 10zm0 2' +
          'c-5 0-8 2.5-8 5.5V22h16v-2.5' +
          'c0-3-3-5.5-8-5.5z"/>' +

        '</svg>' +

      '</div>';

  }


  panel.innerHTML =

    '<div id="va-header">' +

      '<button id="va-sound-btn" type="button">' +

        '<svg viewBox="0 0 24 24">' +

          '<path d="M11 5L6 9H3v6h3l5 4V5z"/>' +

          '<path d="M15.5 8.5a5 5 0 0 1 0 7"/>' +

          '<path d="M18 6a8.5 8.5 0 0 1 0 12"/>' +

        '</svg>' +

      '</button>' +


      '<button id="va-transcript-btn" type="button">' +

        '<svg viewBox="0 0 24 24">' +

          '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8' +
          ' 8.5 8.5 0 0 1-7.6 4.7' +
          ' 8.38 8.38 0 0 1-3.8-.9' +
          'L3 21l1.9-5.7' +
          'A8.38 8.38 0 0 1 4 11.5' +
          ' 8.5 8.5 0 0 1 8.7 3.9' +
          ' 8.38 8.38 0 0 1 12.5 3' +
          'h.5a8.5 8.5 0 0 1 8 8z"/>' +

        '</svg>' +

      '</button>' +


      '<button id="va-close" type="button">' +

        '&times;' +

      '</button>' +


      '<div id="va-avatar">' +

        '<div id="va-avatar-inner">' +

          avatarHTML +

        '</div>' +

      '</div>' +


      '<div id="va-title">' +

        '<span class="brand">Fexa Agents</span> ' +

        '<span class="support">Support</span>' +

      '</div>' +


      '<div id="va-subtitle">' +

        'Tap start call to connect' +

      '</div>' +

    '</div>' +


    /* customer fields */

    '<div id="va-user-form">' +

      '<input ' +
        'id="va-name" ' +
        'class="va-input" ' +
        'type="text" ' +
        'placeholder="Your Name" ' +
        'autocomplete="name">' +

      '<input ' +
        'id="va-phone" ' +
        'class="va-input" ' +
        'type="tel" ' +
        'placeholder="Your Contact Number" ' +
        'autocomplete="tel">' +

      '<input ' +
        'id="va-email" ' +
        'class="va-input" ' +
        'type="email" ' +
        'placeholder="Your Email" ' +
        'autocomplete="email">' +

    '</div>' +


    /* chat */

    '<div id="va-chat">' +

      '<div class="va-empty" id="va-empty">' +

        '🎙️ Start Talking' +

      '</div>' +

    '</div>' +


    /* controls */

    '<div id="va-control">' +

      '<div id="va-status">' +

        'Ready to connect' +

      '</div>' +

      '<div id="va-call-row">' +

        '<div id="va-orb">' +

          '<svg viewBox="0 0 24 24">' +

            '<path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3z"/>' +

            '<path d="M19 11a7 7 0 0 1-14 0"/>' +

            '<path d="M12 18v3"/>' +

          '</svg>' +

        '</div>' +

        '<button id="va-mic-btn" type="button">' +

          '☎ Start Call' +

        '</button>' +

      '</div>' +

    '</div>' +


    '<div id="va-footer">' +

      // 'Powered By - fexaagents.com' +

    '</div>';


  document.body.appendChild(
    panel
  );


  // ============================================================
  // ELEMENTS System
  // ============================================================

  var closeBtn =
    panel.querySelector(
      "#va-close"
    );

  var micBtn =
    panel.querySelector(
      "#va-mic-btn"
    );

  var soundBtn =
    panel.querySelector(
      "#va-sound-btn"
    );

  var transcriptBtn =
    panel.querySelector(
      "#va-transcript-btn"
    );

  var statusEl =
    panel.querySelector(
      "#va-status"
    );

  var orbEl =
    panel.querySelector(
      "#va-orb"
    );

  var chatEl =
    panel.querySelector(
      "#va-chat"
    );

  var emptyEl =
    panel.querySelector(
      "#va-empty"
    );


  // customer fields

  var nameInput =
    panel.querySelector(
      "#va-name"
    );

  var phoneInput =
    panel.querySelector(
      "#va-phone"
    );

  var emailInput =
    panel.querySelector(
      "#va-email"
    );


  // ============================================================
  // STATUS System
  // ============================================================

  function setStatus(text) {

    statusEl.textContent =
      text;

  }


  // ============================================================
  // CUSTOMER VALIDATION System
  // ============================================================

  function validateCustomerForm() {

    var name =
      nameInput.value.trim();

    var phone =
      phoneInput.value.trim();

    var email =
      emailInput.value.trim();

    var valid = true;


    nameInput.classList.remove(
      "va-invalid"
    );

    phoneInput.classList.remove(
      "va-invalid"
    );

    emailInput.classList.remove(
      "va-invalid"
    );


    if (!name) {

      nameInput.classList.add(
        "va-invalid"
      );

      valid = false;
    }


    if (!phone) {

      phoneInput.classList.add(
        "va-invalid"
      );

      valid = false;
    }


    if (
      !email ||
      !emailInput.checkValidity()
    ) {

      emailInput.classList.add(
        "va-invalid"
      );

      valid = false;
    }


    if (!valid) {

      setStatus(
        "Please enter your name, phone and valid email"
      );

      return false;
    }


    return true;
  }


  [
    nameInput,
    phoneInput,
    emailInput
  ].forEach(
    function (input) {

      input.addEventListener(
        "input",
        function () {

          input.classList.remove(
            "va-invalid"
          );

          if (!sessionActive) {

            setStatus(
              "Ready to connect"
            );

          }

        }
      );

    }
  );


  // ============================================================
  // OPEN / CLOSE System
  // ============================================================

  bubble.addEventListener(
    "click",
    function () {

      panel.classList.toggle(
        "open"
      );

    }
  );


  closeBtn.addEventListener(
    "click",
    function () {

      panel.classList.remove(
        "open"
      );

      stopSession();

    }
  );


  transcriptBtn.addEventListener(
    "click",
    function () {

      panel.classList.toggle(
        "show-transcript"
      );

      transcriptBtn.classList.toggle(
        "active"
      );

    }
  );


  // ============================================================
  // CHAT System
  // ============================================================

  var activeAssistantMessage =
    null;

  var activeUserMessage =
    null;


  function removeEmptyMessage() {

    if (
      emptyEl &&
      emptyEl.parentNode
    ) {

      emptyEl.remove();

      emptyEl = null;

    }

  }


  function createMessage(
    role,
    text
  ) {

    removeEmptyMessage();

    var wrapper =
      document.createElement(
        "div"
      );

    wrapper.className =
      "va-message " +
      role;


    var content =
      document.createElement(
        "div"
      );

    content.className =
      "va-bubble-msg";


    var label =
      document.createElement(
        "div"
      );

    label.className =
      "va-label";


    label.textContent =
      role === "user"
        ? "👤 You"
        : "🤖 AI";


    var textEl =
      document.createElement(
        "div"
      );

    textEl.textContent =
      text;


    content.appendChild(
      label
    );

    content.appendChild(
      textEl
    );

    wrapper.appendChild(
      content
    );

    chatEl.appendChild(
      wrapper
    );


    chatEl.scrollTop =
      chatEl.scrollHeight;


    return textEl;

  }


  function addTranscript(
    role,
    text
  ) {

    if (!text) return;

    text =
      String(text).trim();

    if (!text) return;


    removeEmptyMessage();


    function appendChunk(
      element,
      chunk
    ) {

      if (!element || !chunk) {
        return;
      }


      var current =
        element.textContent || "";


      chunk =
        String(chunk).trim();


      if (!chunk) return;


      if (!current) {

        element.textContent =
          chunk;

        return;

      }


      var lastChar =
        current.charAt(
          current.length - 1
        );

      var firstChar =
        chunk.charAt(0);


      var punctuation =
        /^[,.;:!?،。！？;ঃ)\]}%]/;


      var opening =
        /^[([{]/;


      if (
        punctuation.test(
          firstChar
        ) ||
        opening.test(
          lastChar
        ) ||
        /\s$/.test(
          current
        )
      ) {

        element.textContent =
          current + chunk;

      } else {

        element.textContent =
          current +
          " " +
          chunk;

      }

    }


    // USER

    if (role === "user") {

      if (
        activeUserMessage &&
        activeUserMessage.parentNode
      ) {

        appendChunk(
          activeUserMessage,
          text
        );

      } else {

        activeUserMessage =
          createMessage(
            "user",
            text
          );

      }

      activeAssistantMessage =
        null;

    }


    // AI

    else {

      if (
        activeAssistantMessage &&
        activeAssistantMessage.parentNode
      ) {

        appendChunk(
          activeAssistantMessage,
          text
        );

      } else {

        activeAssistantMessage =
          createMessage(
            "assistant",
            text
          );

      }

      activeUserMessage =
        null;

    }


    chatEl.scrollTop =
      chatEl.scrollHeight;

  }


  function clearChat() {

    chatEl.innerHTML =

      '<div class="va-empty" id="va-empty">' +
        '🎙️ Start Talking' +
      '</div>';


    emptyEl =
      chatEl.querySelector(
        "#va-empty"
      );


    activeAssistantMessage =
      null;

    activeUserMessage =
      null;

  }


  // ============================================================
  // AUDIO System
  // ============================================================

  var ws = null;

  var inputCtx = null;

  var outputCtx = null;

  var micStream = null;

  var processorNode = null;

  var sourceNode = null;

  var sessionActive = false;

  var playHeadTime = 0;


  function base64FromInt16(
    int16arr
  ) {

    var bytes =
      new Uint8Array(
        int16arr.buffer
      );

    var binary = "";


    for (
      var i = 0;
      i < bytes.length;
      i++
    ) {

      binary +=
        String.fromCharCode(
          bytes[i]
        );

    }


    return btoa(
      binary
    );

  }


  function int16FromBase64(
    b64
  ) {

    var binary =
      atob(b64);


    var bytes =
      new Uint8Array(
        binary.length
      );


    for (
      var i = 0;
      i < binary.length;
      i++
    ) {

      bytes[i] =
        binary.charCodeAt(i);

    }


    return new Int16Array(
      bytes.buffer
    );

  }


  function floatTo16BitPCM(
    float32arr
  ) {

    var out =
      new Int16Array(
        float32arr.length
      );


    for (
      var i = 0;
      i < float32arr.length;
      i++
    ) {

      var s =
        Math.max(
          -1,
          Math.min(
            1,
            float32arr[i]
          )
        );


      out[i] =
        s < 0
          ? s * 0x8000
          : s * 0x7fff;

    }


    return out;

  }


  // ============================================================
  // AUDIO PLAYBACK System
  // ============================================================

  function playPCM16(
    base64Data,
    sampleRate
  ) {

    if (!outputCtx) {

      outputCtx =
        new (
          window.AudioContext ||
          window.webkitAudioContext
        )({
          sampleRate:
            sampleRate
        });

    }


    var int16 =
      int16FromBase64(
        base64Data
      );


    var float32 =
      new Float32Array(
        int16.length
      );


    for (
      var i = 0;
      i < int16.length;
      i++
    ) {

      float32[i] =
        int16[i] / 0x8000;

    }


    var buffer =
      outputCtx.createBuffer(
        1,
        float32.length,
        sampleRate
      );


    buffer.copyToChannel(
      float32,
      0
    );


    var src =
      outputCtx.createBufferSource();


    src.buffer =
      buffer;


    src.connect(
      outputCtx.destination
    );


    var now =
      outputCtx.currentTime;


    if (
      playHeadTime < now
    ) {

      playHeadTime =
        now + 0.05;

    }


    src.start(
      playHeadTime
    );


    playHeadTime +=
      buffer.duration;


    orbEl.classList.add(
      "speaking"
    );


    src.onended =
      function () {

        if (
          outputCtx &&
          outputCtx.currentTime >=
            playHeadTime - 0.05
        ) {

          orbEl.classList.remove(
            "speaking"
          );

        }

      };

  }


  function stopPlayback() {

    if (outputCtx) {

      try {
        outputCtx.close();
      } catch (e) {}

      outputCtx = null;

    }


    playHeadTime = 0;


    orbEl.classList.remove(
      "speaking"
    );

  }


  // ============================================================
  // START SESSION System
  // ============================================================

  async function startSession() {

    if (sessionActive) {
      return;
    }


    if (!validateCustomerForm()) {
      return;
    }


    setStatus(
      "Connecting..."
    );


    panel.classList.add(
      "in-call"
    );


    micBtn.disabled =
      true;


    try {

      micStream =
        await navigator.mediaDevices
          .getUserMedia({
            audio: {
              channelCount: 1
            }
          });

    } catch (e) {

      setStatus(
        "Microphone access required 🎙️"
      );


      micBtn.disabled =
        false;


      panel.classList.remove(
        "in-call"
      );


      return;

    }


    ws =
      new WebSocket(
        WS_BASE +
        "&name=" + encodeURIComponent(nameInput.value.trim()) +
        "&phone=" + encodeURIComponent(phoneInput.value.trim()) +
        "&email=" + encodeURIComponent(emailInput.value.trim())
      );


    ws.onopen =
      function () {

        setStatus(
          "Connected, preparing..."
        );

      };


    ws.onmessage =
      function (event) {

        var msg;


        try {

          msg =
            JSON.parse(
              event.data
            );

        } catch (e) {

          return;

        }


        // ======================================================
        // READY System
        // ======================================================

        if (
          msg.type === "ready"
        ) {

          sessionActive =
            true;


          panel.classList.add(
            "in-call"
          );


          micBtn.disabled =
            false;


          micBtn.innerHTML =
            "⏹ Stop Call";


          setStatus(
            "Listening... Talk"
          );


          beginMicStreaming();


          return;

        }


        // ======================================================
        // TRANSCRIPT System
        // ======================================================

        if (
          msg.type === "transcript"
        ) {

          addTranscript(
            msg.role,
            msg.text
          );

          return;

        }


        // ======================================================
        // SERVER CONTENT / AUDIO System
        // ======================================================

        if (
          msg.type ===
          "serverContent"
        ) {

          var sc =
            msg.data;


          if (
            sc.interrupted
          ) {

            stopPlayback();

            activeAssistantMessage =
              null;

          }


          if (
            sc.modelTurn &&
            sc.modelTurn.parts
          ) {

            sc.modelTurn.parts.forEach(
              function (part) {

                if (
                  part.inlineData &&
                  part.inlineData.data
                ) {

                  playPCM16(
                    part.inlineData.data,
                    24000
                  );

                }

              }
            );

          }


          if (
            sc.turnComplete
          ) {

            activeAssistantMessage =
              null;

            activeUserMessage =
              null;


            setStatus(
              "Listening... Talk"
            );

          }


          return;

        }


        // ======================================================
        // ERROR System
        // ======================================================

        if (
          msg.type === "error"
        ) {

          setStatus(
            "Something Problem " +
            msg.message
          );

          return;

        }


        // ======================================================
        // CLOSED System
        // ======================================================

        if (
          msg.type === "closed"
        ) {

          setStatus(
            "Session closed"
          );

          stopSession();

          return;

        }

      };


    ws.onerror =
      function () {

        setStatus(
          "Connection error"
        );

      };


    ws.onclose =
      function () {

        sessionActive =
          false;


        micBtn.innerHTML =
          "☎ Start Call";

      };

  }


  // ============================================================
  // MICROPHONE STREAMING System
  // ============================================================

  function beginMicStreaming() {

    inputCtx =
      new (
        window.AudioContext ||
        window.webkitAudioContext
      )({
        sampleRate: 16000
      });


    sourceNode =
      inputCtx.createMediaStreamSource(
        micStream
      );


    processorNode =
      inputCtx.createScriptProcessor(
        4096,
        1,
        1
      );


    sourceNode.connect(
      processorNode
    );


    processorNode.connect(
      inputCtx.destination
    );


    var speaking =
      false;


    processorNode.onaudioprocess =
      function (e) {

        if (
          !sessionActive ||
          !ws ||
          ws.readyState !==
            WebSocket.OPEN
        ) {

          return;

        }


        var input =
          e.inputBuffer
            .getChannelData(0);


        // ======================================================
        // VAD System
        // ======================================================

        var sum = 0;


        for (
          var i = 0;
          i < input.length;
          i++
        ) {

          sum +=
            input[i] *
            input[i];

        }


        var rms =
          Math.sqrt(
            sum /
            input.length
          );


        if (
          rms > 0.02 &&
          !speaking
        ) {

          speaking =
            true;


          orbEl.classList.add(
            "listening"
          );

        }


        else if (
          rms <= 0.02 &&
          speaking
        ) {

          speaking =
            false;


          orbEl.classList.remove(
            "listening"
          );

        }


        // ======================================================
        // PCM System
        // ======================================================

        var pcm16 =
          floatTo16BitPCM(
            input
          );


        var b64 =
          base64FromInt16(
            pcm16
          );


        ws.send(
          JSON.stringify({
            type: "audio",
            data: b64
          })
        );

      };

  }


  // ============================================================
  // STOP SESSION System
  // ============================================================

  function stopSession() {

    sessionActive =
      false;


    panel.classList.remove(
      "in-call"
    );


    if (ws) {

      try {

        ws.close();

      } catch (e) {}

      ws = null;

    }


    if (processorNode) {

      try {
        processorNode.disconnect();
      } catch (e) {}

      processorNode = null;

    }


    if (sourceNode) {

      try {
        sourceNode.disconnect();
      } catch (e) {}

      sourceNode = null;

    }


    if (inputCtx) {

      try {
        inputCtx.close();
      } catch (e) {}

      inputCtx = null;

    }


    stopPlayback();


    if (micStream) {

      micStream
        .getTracks()
        .forEach(
          function (track) {

            track.stop();

          }
        );


      micStream = null;

    }


    micBtn.disabled =
      false;


    micBtn.innerHTML =
      "☎ Start Call";


    setStatus(
      "Ready to connect"
    );


    orbEl.classList.remove(
      "listening",
      "speaking"
    );


    activeAssistantMessage =
      null;

    activeUserMessage =
      null;

  }


  // ============================================================
  // CALL BUTTON System
  // ============================================================

  micBtn.addEventListener(
    "click",
    function () {

      if (sessionActive) {

        stopSession();

        return;

      }


      startSession();

    }
  );


  // ============================================================
  // SOUND BUTTON System
  // ============================================================

  soundBtn.addEventListener(
    "click",
    async function () {

      try {

        if (outputCtx) {

          if (
            outputCtx.state ===
            "suspended"
          ) {

            await outputCtx.resume();

          }

        }


        setStatus(
          "Sound enabled"
        );

      } catch (e) {}

    }
  );


  // ============================================================
  // END System
  // ============================================================

})();