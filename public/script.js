/* =================================================================
   SokAlike007 Hacking AI — Frontend logic
   Chat state · API calls · Markdown · Code highlighting · History
   Edit/Regenerate/Copy · File upload · Voice I/O · TTS
   Export/Import · Search · Settings persistence
   ================================================================= */

(() => {
  "use strict";

  // ---------- Marked + Highlight.js setup ----------
  marked.setOptions({
    breaks: true,
    gfm: true,
    highlight: (code, lang) => {
      if (lang && hljs.getLanguage(lang)) {
        try { return hljs.highlight(code, { language: lang }).value; }
        catch { /* fall through */ }
      }
      try { return hljs.highlightAuto(code).value; }
      catch { return code; }
    },
  });

  // ---------- State ----------
  const STORAGE_KEY = "sokalike_chats_v1";
  const SETTINGS_KEY = "sokalike_settings_v1";

  const PERSONALITY_PRESETS = {
    default: "You are a helpful, balanced AI assistant. Provide accurate, concise, and well-structured answers.",
    friendly: "You are a warm, friendly AI companion. Use a casual tone, emojis sparingly, and engage the user warmly.",
    professional: "You are a professional AI assistant. Use formal language, be precise, structured, and authoritative.",
    creative: "You are a highly creative AI. Think outside the box, suggest imaginative ideas, and use vivid language.",
    concise: "You are a concise AI. Give direct, no-fluff answers. Skip pleasantries.",
    teacher: "You are a patient teacher. Explain step-by-step, use analogies, and check for understanding.",
    dev: "You are a senior software engineer. Provide production-ready code, explain trade-offs, and follow best practices.",
    custom: "",
  };

  const state = {
    chats: {},          // { [id]: Chat }
    currentId: null,
    settings: {
      systemPrompt: "",
      personality: "default",
      model: "deepseek-v4-flash",
      modelProvider: "auto",
      modelType: "chat",
      effort: "Medium",
      stream: false,
      ttsVoice: "",
      theme: "dark",
    },
    attachedFiles: [],
    isStreaming: false,
    abortController: null,
  };

  // ---------- DOM helpers ----------
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ---------- Persistence ----------
  function loadState() {
    try {
      const chats = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      state.chats = chats && typeof chats === "object" ? chats : {};
    } catch { state.chats = {}; }

    try {
      const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
      if (s && typeof s === "object") {
        state.settings = { ...state.settings, ...s };
      }
    } catch { /* defaults */ }
  }

  function saveChats() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.chats)); }
    catch (e) { console.warn("Failed to save chats:", e); }
  }

  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings)); }
    catch (e) { console.warn("Failed to save settings:", e); }
  }

  // ---------- Toast ----------
  function toast(message, type = "info", duration = 2500) {
    const t = document.createElement("div");
    t.className = `toast ${type}`;
    t.textContent = message;
    $("#toastContainer").appendChild(t);
    setTimeout(() => {
      t.classList.add("removing");
      setTimeout(() => t.remove(), 250);
    }, duration);
  }

  // ---------- Chat CRUD ----------
  function newChat(title = "New chat") {
    const id = uid();
    state.chats[id] = {
      id,
      title,
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    state.currentId = id;
    saveChats();
    renderChatList();
    renderMessages();
    return state.chats[id];
  }

  function deleteChat(id) {
    delete state.chats[id];
    if (state.currentId === id) {
      const remaining = Object.keys(state.chats);
      state.currentId = remaining.length ? remaining[remaining.length - 1] : null;
    }
    saveChats();
    renderChatList();
    renderMessages();
  }

  function renameChat(id, title) {
    if (!state.chats[id]) return;
    state.chats[id].title = title || "Untitled chat";
    state.chats[id].updatedAt = Date.now();
    saveChats();
    renderChatList();
    updateTopbarTitle();
  }

  function getCurrentChat() {
    if (!state.currentId || !state.chats[state.currentId]) return null;
    return state.chats[state.currentId];
  }

  function switchChat(id) {
    if (!state.chats[id]) return;
    state.currentId = id;
    renderChatList();
    renderMessages();
  }

  function clearCurrentChat() {
    const chat = getCurrentChat();
    if (!chat) return;
    if (!confirm("Clear all messages in this chat? This cannot be undone.")) return;
    chat.messages = [];
    chat.title = "New chat";
    chat.updatedAt = Date.now();
    saveChats();
    renderChatList();
    renderMessages();
  }

  // ---------- Auto title ----------
  function autoTitle(chat) {
    if (chat.title && chat.title !== "New chat") return;
    const firstUser = chat.messages.find((m) => m.role === "user");
    if (firstUser) {
      chat.title = firstUser.content.slice(0, 40).trim() || "New chat";
    }
  }

  // ---------- Render chat list ----------
  function renderChatList(filter = "") {
    const list = $("#chatList");
    const items = Object.values(state.chats)
      .sort((a, b) => b.updatedAt - a.updatedAt);

    const filtered = filter
      ? items.filter((c) =>
          c.title.toLowerCase().includes(filter.toLowerCase()) ||
          c.messages.some((m) => m.content.toLowerCase().includes(filter.toLowerCase()))
        )
      : items;

    if (!filtered.length) {
      list.innerHTML = `<div class="chat-list-empty">${filter ? "No matches found." : "No conversations yet.<br>Click \"New chat\" to begin."}</div>`;
      return;
    }

    list.innerHTML = filtered.map((c) => `
      <div class="chat-item ${c.id === state.currentId ? "active" : ""}" data-id="${c.id}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        <span class="chat-title">${escapeHtml(c.title)}</span>
        <div class="chat-actions">
          <button class="rename-chat" data-id="${c.id}" title="Rename">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button class="delete-chat" data-id="${c.id}" title="Delete">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
          </button>
        </div>
      </div>
    `).join("");

    list.querySelectorAll(".chat-item").forEach((el) => {
      el.addEventListener("click", (e) => {
        if (e.target.closest(".chat-actions")) return;
        switchChat(el.dataset.id);
        if (window.innerWidth <= 768) toggleSidebar(true);
      });
    });
    list.querySelectorAll(".rename-chat").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        const title = prompt("Rename chat:", state.chats[id]?.title || "");
        if (title !== null) renameChat(id, title.trim());
      });
    });
    list.querySelectorAll(".delete-chat").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (confirm("Delete this conversation permanently?")) deleteChat(btn.dataset.id);
      });
    });
  }

  // ---------- Render messages ----------
  function renderMessages() {
    const chat = getCurrentChat();
    const welcome = $("#welcomeScreen");
    const messagesEl = $("#messages");

    if (!chat || chat.messages.length === 0) {
      welcome.hidden = false;
      messagesEl.hidden = true;
      messagesEl.innerHTML = "";
      updateTopbarTitle();
      return;
    }

    welcome.hidden = true;
    messagesEl.hidden = false;
    messagesEl.innerHTML = chat.messages.map(renderMessageHTML).join("");

    // Attach action handlers
    messagesEl.querySelectorAll(".msg-action-btn").forEach(attachMsgAction);
    messagesEl.querySelectorAll("pre code").forEach((block) => {
      try { hljs.highlightElement(block); } catch { /* noop */ }
    });
    addCopyButtonsToCodeBlocks(messagesEl);

    updateTopbarTitle();
    scrollToBottom();
  }

  function renderMessageHTML(m) {
    const isUser = m.role === "user";
    const avatar = isUser ? "U" : "AI";
    const roleLabel = isUser ? "You" : "Assistant";
    let contentHTML;
    if (isUser) {
      contentHTML = escapeHtml(m.content).replace(/\n/g, "<br>");
    } else {
      contentHTML = renderMarkdown(m.content || "");
    }

    const actions = isUser ? `
      <button class="msg-action-btn" data-action="edit" data-id="${m.id}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        Edit
      </button>
    ` : `
      <button class="msg-action-btn" data-action="copy" data-id="${m.id}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        Copy
      </button>
      <button class="msg-action-btn" data-action="speak" data-id="${m.id}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
        Speak
      </button>
      <button class="msg-action-btn" data-action="regenerate" data-id="${m.id}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
        Regenerate
      </button>
    `;

    return `
      <div class="message ${isUser ? "user" : "ai"}" data-id="${m.id}">
        <div class="message-avatar">${avatar}</div>
        <div class="message-body">
          <div class="message-role">${roleLabel}</div>
          <div class="message-content">${contentHTML}</div>
          <div class="edit-area" data-edit-id="${m.id}">
            <textarea>${escapeHtml(m.content)}</textarea>
            <div class="edit-actions">
              <button class="btn-primary" data-action="save-edit" data-id="${m.id}">Save &amp; resend</button>
              <button class="btn-secondary" data-action="cancel-edit">Cancel</button>
            </div>
          </div>
          <div class="message-actions">${actions}</div>
        </div>
      </div>
    `;
  }

  function renderMarkdown(text) {
    try {
      const raw = marked.parse(text || "");
      return DOMPurify.sanitize(raw, {
        ADD_ATTR: ["target", "rel"],
      });
    } catch {
      return escapeHtml(text);
    }
  }

  function addCopyButtonsToCodeBlocks(container) {
    container.querySelectorAll("pre").forEach((pre) => {
      if (pre.querySelector(".code-header")) return;
      const code = pre.querySelector("code");
      if (!code) return;
      const lang = (code.className.match(/language-(\w+)/) || [])[1] || "code";
      const header = document.createElement("div");
      header.className = "code-header";
      header.innerHTML = `<span>${lang}</span><button class="copy-code">Copy</button>`;
      pre.insertBefore(header, code);
      header.querySelector(".copy-code").addEventListener("click", () => {
        navigator.clipboard.writeText(code.textContent).then(() => {
          toast("Code copied", "success", 1500);
        });
      });
    });
  }

  // ---------- Message actions ----------
  function attachMsgAction(btn) {
    btn.addEventListener("click", () => {
      const action = btn.dataset.action;
      const id = btn.dataset.id;
      if (action === "copy") copyMessage(id);
      else if (action === "speak") speakMessage(id);
      else if (action === "regenerate") regenerateMessage(id);
      else if (action === "edit") toggleEdit(id, true);
      else if (action === "save-edit") saveEdit(id);
      else if (action === "cancel-edit") toggleEdit(id, false);
    });
  }

  function copyMessage(id) {
    const chat = getCurrentChat();
    const msg = chat?.messages.find((m) => m.id === id);
    if (!msg) return;
    navigator.clipboard.writeText(msg.content).then(() => toast("Message copied", "success", 1500));
  }

  function speakMessage(id) {
    const chat = getCurrentChat();
    const msg = chat?.messages.find((m) => m.id === id);
    if (!msg) return;
    if (!("speechSynthesis" in window)) {
      toast("Text-to-speech not supported in this browser", "error");
      return;
    }
    window.speechSynthesis.cancel();
    const utt = new SpeechSynthesisUtterance(msg.content.replace(/```[\s\S]*?```/g, " (code block)"));
    if (state.settings.ttsVoice) {
      const v = speechSynthesis.getVoices().find((v) => v.name === state.settings.ttsVoice);
      if (v) utt.voice = v;
    }
    utt.rate = 1;
    utt.pitch = 1;
    window.speechSynthesis.speak(utt);
    toast("Speaking...", "info", 1500);
  }

  function regenerateMessage(id) {
    const chat = getCurrentChat();
    if (!chat) return;
    const idx = chat.messages.findIndex((m) => m.id === id);
    if (idx === -1) return;
    // Remove the AI message and any messages after it up to next user
    // Find the user message that triggered this AI response
    let userIdx = idx - 1;
    while (userIdx >= 0 && chat.messages[userIdx].role !== "user") userIdx--;
    if (userIdx < 0) return;
    const userMsg = chat.messages[userIdx];

    // Truncate everything after the user message
    chat.messages = chat.messages.slice(0, userIdx + 1);
    saveChats();
    renderMessages();
    sendToAI(userMsg.content);
  }

  function toggleEdit(id, open) {
    const msgEl = $(`.message[data-id="${id}"]`);
    if (!msgEl) return;
    const editArea = msgEl.querySelector(".edit-area");
    const content = msgEl.querySelector(".message-content");
    if (open) {
      editArea.style.display = "block";
      content.style.display = "none";
      editArea.querySelector("textarea").focus();
    } else {
      editArea.style.display = "none";
      content.style.display = "";
    }
  }

  function saveEdit(id) {
    const chat = getCurrentChat();
    if (!chat) return;
    const idx = chat.messages.findIndex((m) => m.id === id);
    if (idx === -1) return;
    const newContent = $(`.edit-area[data-edit-id="${id}"] textarea`).value.trim();
    if (!newContent) return;
    // Truncate everything from this message onward
    chat.messages = chat.messages.slice(0, idx);
    chat.messages.push({ id, role: "user", content: newContent, createdAt: Date.now() });
    saveChats();
    renderMessages();
    sendToAI(newContent);
  }

  function updateTopbarTitle() {
    const chat = getCurrentChat();
    $("#currentChatTitle").textContent = chat && chat.messages.length
      ? chat.title
      : "SokAlike007 Hacking AI";
  }

  function scrollToBottom() {
    const area = $("#chatArea");
    area.scrollTop = area.scrollHeight;
  }

  // ---------- API call ----------
  async function sendToAI(userMessage) {
    let chat = getCurrentChat();
    if (!chat) chat = newChat();
    if (!chat.messages.find((m) => m.role === "user" && m.content === userMessage)) {
      chat.messages.push({ id: uid(), role: "user", content: userMessage, createdAt: Date.now() });
    }
    autoTitle(chat);
    chat.updatedAt = Date.now();
    saveChats();
    renderMessages();
    renderChatList($("#searchInput").value);

    // Add placeholder AI message
    const aiId = uid();
    chat.messages.push({ id: aiId, role: "ai", content: "", createdAt: Date.now(), pending: true });
    renderMessages();

    // Show typing indicator
    const aiEl = $(`.message[data-id="${aiId}"] .message-content`);
    if (aiEl) aiEl.innerHTML = `<div class="typing-indicator"><span></span><span></span><span></span></div>`;

    state.isStreaming = true;
    state.abortController = new AbortController();

    try {
      const body = {
        message: userMessage,
        model: state.settings.model,
        modelProvider: state.settings.modelProvider,
        modelType: state.settings.modelType,
        effort: state.settings.effort,
        stream: state.settings.stream,
        systemPrompt: getEffectiveSystemPrompt(),
      };

      if (state.settings.stream) {
        await streamResponse(body, aiId, chat);
      } else {
        const res = await fetch("/api/chatmodel", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: state.abortController.signal,
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({ message: res.statusText }));
          throw new Error(err.message || `Server error (${res.status})`);
        }

        const contentType = res.headers.get("content-type") || "";
        let reply;
        if (contentType.includes("application/json")) {
          const data = await res.json();
          reply = extractReply(data);
        } else {
          reply = await res.text();
        }

        updateAIMessage(aiId, reply, chat);
      }
    } catch (err) {
      if (err.name === "AbortError") {
        updateAIMessage(aiId, "_Response stopped by user._", chat);
      } else {
        console.error(err);
        updateAIMessage(aiId, `**Error:** ${err.message}`, chat);
        toast(err.message, "error");
      }
    } finally {
      state.isStreaming = false;
      state.abortController = null;
      updateSendButton();
    }
  }

  async function streamResponse(body, aiId, chat) {
    const res = await fetch("/api/chatmodel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: state.abortController.signal,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ message: res.statusText }));
      throw new Error(err.message || `Server error (${res.status})`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let fullText = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Parse SSE-like chunks
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":")) continue;
        if (trimmed.startsWith("data:")) {
          const data = trimmed.slice(5).trim();
          if (data === "[DONE]") continue;
          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta?.content
                       || parsed.choices?.[0]?.message?.content
                       || parsed.content
                       || parsed.delta
                       || "";
            if (delta) {
              fullText += delta;
              updateAIMessage(aiId, fullText, chat, true);
            }
          } catch {
            // Treat as plain text chunk
            fullText += trimmed;
            updateAIMessage(aiId, fullText, chat, true);
          }
        } else {
          // Plain text stream (non-SSE)
          fullText += trimmed + "\n";
          updateAIMessage(aiId, fullText, chat, true);
        }
      }
    }

    if (!fullText.trim()) {
      // Fallback: maybe the whole response was plain text
      fullText = buffer;
    }
    updateAIMessage(aiId, fullText, chat);
  }

  function extractReply(data) {
    if (typeof data === "string") return data;
    if (data.choices?.[0]?.message?.content) return data.choices[0].message.content;
    if (data.choices?.[0]?.text) return data.choices[0].text;
    if (data.content) return data.content;
    if (data.reply) return data.reply;
    if (data.message) return typeof data.message === "string" ? data.message : JSON.stringify(data.message, null, 2);
    if (data.response) return typeof data.response === "string" ? data.response : JSON.stringify(data.response, null, 2);
    return JSON.stringify(data, null, 2);
  }

  function updateAIMessage(id, content, chat, streaming = false) {
    const msg = chat.messages.find((m) => m.id === id);
    if (!msg) return;
    msg.content = content;
    msg.pending = streaming;
    if (!streaming) {
      msg.updatedAt = Date.now();
      chat.updatedAt = Date.now();
      saveChats();
      renderChatList($("#searchInput").value);
    }

    const contentEl = $(`.message[data-id="${id}"] .message-content`);
    if (contentEl) {
      contentEl.innerHTML = renderMarkdown(content || "");
      contentEl.querySelectorAll("pre code").forEach((block) => {
        try { hljs.highlightElement(block); } catch { /* noop */ }
      });
      addCopyButtonsToCodeBlocks(contentEl.parentElement);
    }
    if (streaming) scrollToBottom();
  }

  // ---------- System prompt ----------
  function getEffectiveSystemPrompt() {
    const p = state.settings.personality;
    const preset = PERSONALITY_PRESETS[p] ?? "";
    if (p === "custom") return state.settings.systemPrompt;
    if (state.settings.systemPrompt) {
      return `${preset}\n\n${state.settings.systemPrompt}`.trim();
    }
    return preset;
  }

  // ---------- File handling ----------
  async function handleFiles(files) {
    const valid = Array.from(files).filter((f) => f.size < 5 * 1024 * 1024);
    if (files.length > valid.length) toast("Some files exceeded 5MB limit", "error");

    for (const file of valid) {
      try {
        const text = await readFileAsText(file);
        state.attachedFiles.push({ name: file.name, type: file.type, size: file.size, text });
      } catch (e) {
        toast(`Could not read ${file.name}`, "error");
      }
    }
    renderFilePreviews();
  }

  function readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      // For non-text files, still try to read as text (best-effort)
      reader.readAsText(file);
    });
  }

  function renderFilePreviews() {
    const container = $("#filePreviews");
    container.innerHTML = state.attachedFiles.map((f, i) => `
      <div class="file-chip">
        <span>${escapeHtml(f.name)} (${(f.size / 1024).toFixed(1)}KB)</span>
        <button data-idx="${i}" title="Remove">&times;</button>
      </div>
    `).join("");
    container.querySelectorAll("button").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.attachedFiles.splice(parseInt(btn.dataset.idx, 10), 1);
        renderFilePreviews();
      });
    });
  }

  function buildMessageWithAttachments(text) {
    if (!state.attachedFiles.length) return text;
    const docs = state.attachedFiles.map((f) =>
      `--- Attached file: ${f.name} (${f.type || "unknown"}) ---\n${f.text}`
    ).join("\n\n");
    return `${docs}\n\n--- User message ---\n${text}`;
  }

  // ---------- Voice input ----------
  let recognition = null;
  function initVoiceInput() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;
    recognition = new SR();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    let finalText = "";
    recognition.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalText += t;
        else interim += t;
      }
      $("#messageInput").value = (finalText + interim).trim();
      autoResizeTextarea();
    };
    recognition.onend = () => {
      $("#micBtn").classList.remove("recording");
    };
    recognition.onerror = (e) => {
      toast(`Voice error: ${e.error}`, "error");
      $("#micBtn").classList.remove("recording");
    };
  }

  function toggleVoiceInput() {
    if (!recognition) {
      toast("Voice input not supported in this browser", "error");
      return;
    }
    if ($("#micBtn").classList.contains("recording")) {
      recognition.stop();
    } else {
      try {
        recognition.start();
        $("#micBtn").classList.add("recording");
        toast("Listening...", "info", 1200);
      } catch (e) {
        toast("Could not start microphone", "error");
      }
    }
  }

  // ---------- Export / Import ----------
  function exportConversations() {
    const data = {
      app: "SokAlike007 Hacking AI",
      version: 1,
      exportedAt: new Date().toISOString(),
      chats: state.chats,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `sokalike-chats-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast("Conversations exported", "success");
  }

  function importConversations(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!data.chats || typeof data.chats !== "object") {
          throw new Error("Invalid file format");
        }
        // Merge by id
        let added = 0;
        for (const [id, chat] of Object.entries(data.chats)) {
          if (!state.chats[id]) {
            state.chats[id] = chat;
            added++;
          }
        }
        saveChats();
        renderChatList();
        toast(`Imported ${added} conversation${added === 1 ? "" : "s"}`, "success");
      } catch (e) {
        toast(`Import failed: ${e.message}`, "error");
      }
    };
    reader.readAsText(file);
  }

  // ---------- Settings UI ----------
  function openSettings() {
    $("#systemPrompt").value = state.settings.systemPrompt;
    $("#personality").value = state.settings.personality;
    $("#modelSelect").value = state.settings.model;
    $("#providerSelect").value = state.settings.modelProvider;
    $("#effortSelect").value = state.settings.effort;
    $("#streamToggle").checked = state.settings.stream;
    populateVoices();
    $("#settingsModal").hidden = false;
  }
  function closeSettings() { $("#settingsModal").hidden = true; }

  function populateVoices() {
    const sel = $("#ttsVoice");
    sel.innerHTML = `<option value="">Browser default</option>`;
    if ("speechSynthesis" in window) {
      const voices = speechSynthesis.getVoices();
      voices.forEach((v) => {
        const opt = document.createElement("option");
        opt.value = v.name;
        opt.textContent = `${v.name} (${v.lang})`;
        if (v.name === state.settings.ttsVoice) opt.selected = true;
        sel.appendChild(opt);
      });
    }
  }

  function saveSettingsFromUI() {
    state.settings.systemPrompt = $("#systemPrompt").value.trim();
    state.settings.personality = $("#personality").value;
    state.settings.model = $("#modelSelect").value;
    state.settings.modelProvider = $("#providerSelect").value;
    state.settings.effort = $("#effortSelect").value;
    state.settings.stream = $("#streamToggle").checked;
    state.settings.ttsVoice = $("#ttsVoice").value;
    saveSettings();
    applySettings();
    closeSettings();
    toast("Settings saved", "success");
  }

  function resetSettings() {
    if (!confirm("Reset all settings to defaults?")) return;
    state.settings = {
      systemPrompt: "",
      personality: "default",
      model: "deepseek-v4-flash",
      modelProvider: "auto",
      modelType: "chat",
      effort: "Medium",
      stream: false,
      ttsVoice: "",
      theme: state.settings.theme,
    };
    saveSettings();
    applySettings();
    openSettings();
    toast("Settings reset", "info");
  }

  function applySettings() {
    document.documentElement.setAttribute("data-theme", state.settings.theme);
    $("#modelBadge").textContent =
      `${state.settings.model} · ${state.settings.modelProvider} · ${state.settings.effort}`;
    updateSendButton();
  }

  // ---------- Theme ----------
  function toggleTheme() {
    state.settings.theme = state.settings.theme === "dark" ? "light" : "dark";
    saveSettings();
    applySettings();
  }

  // ---------- Sidebar ----------
  function toggleSidebar(forceCollapse) {
    const app = $("#app");
    if (forceCollapse === true) app.classList.add("sidebar-collapsed");
    else if (forceCollapse === false) app.classList.remove("sidebar-collapsed");
    else app.classList.toggle("sidebar-collapsed");
  }

  // ---------- Input ----------
  function autoResizeTextarea() {
    const ta = $("#messageInput");
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
  }

  function updateSendButton() {
    const btn = $("#sendBtn");
    btn.disabled = state.isStreaming || !$("#messageInput").value.trim();
  }

  function handleSend() {
    const input = $("#messageInput");
    let text = input.value.trim();
    if (!text && !state.attachedFiles.length) return;
    if (state.isStreaming) {
      // Stop streaming
      state.abortController?.abort();
      return;
    }
    text = buildMessageWithAttachments(text);
    state.attachedFiles = [];
    renderFilePreviews();
    input.value = "";
    autoResizeTextarea();
    updateSendButton();
    sendToAI(text);
  }

  // ---------- Init ----------
  function init() {
    loadState();
    applySettings();
    initVoiceInput();

    // Speech synthesis voices may load asynchronously
    if ("speechSynthesis" in window) {
      speechSynthesis.onvoiceschanged = populateVoices;
    }

    // Welcome suggestions
    $$("#welcomeSuggestions .suggestion-card").forEach((card) => {
      card.addEventListener("click", () => {
        $("#messageInput").value = card.dataset.prompt;
        autoResizeTextarea();
        updateSendButton();
        handleSend();
      });
    });

    // Buttons
    $("#newChatBtn").addEventListener("click", () => {
      newChat();
      if (window.innerWidth <= 768) toggleSidebar(true);
    });
    $("#sidebarToggle").addEventListener("click", () => toggleSidebar());
    $("#menuBtn").addEventListener("click", () => toggleSidebar());
    $("#themeToggle").addEventListener("click", toggleTheme);
    $("#clearChatBtn").addEventListener("click", clearCurrentChat);
    $("#sendBtn").addEventListener("click", handleSend);
    $("#micBtn").addEventListener("click", toggleVoiceInput);
    $("#attachBtn").addEventListener("click", () => $("#fileInput").click());
    $("#fileInput").addEventListener("change", (e) => handleFiles(e.target.files));
    $("#importBtn").addEventListener("click", () => {
      const inp = document.createElement("input");
      inp.type = "file";
      inp.accept = "application/json";
      inp.onchange = (e) => e.target.files[0] && importConversations(e.target.files[0]);
      inp.click();
    });
    $("#exportBtn").addEventListener("click", exportConversations);
    $("#settingsBtn").addEventListener("click", openSettings);
    $("#closeSettings").addEventListener("click", closeSettings);
    $("#saveSettings").addEventListener("click", saveSettingsFromUI);
    $("#resetSettings").addEventListener("click", resetSettings);
    $("#settingsModal").addEventListener("click", (e) => {
      if (e.target === $("#settingsModal")) closeSettings();
    });

    // Search
    $("#searchInput").addEventListener("input", (e) => renderChatList(e.target.value));

    // Input area
    const ta = $("#messageInput");
    ta.addEventListener("input", () => {
      autoResizeTextarea();
      updateSendButton();
    });
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    });

    // Drag & drop files
    const chatArea = $("#chatArea");
    chatArea.addEventListener("dragover", (e) => {
      e.preventDefault();
      chatArea.style.background = "var(--bg-active)";
    });
    chatArea.addEventListener("dragleave", () => {
      chatArea.style.background = "";
    });
    chatArea.addEventListener("drop", (e) => {
      e.preventDefault();
      chatArea.style.background = "";
      if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
    });

    // Close sidebar on outside click (mobile)
    document.addEventListener("click", (e) => {
      if (window.innerWidth > 768) return;
      const sidebar = $("#sidebar");
      const menuBtn = $("#menuBtn");
      if (!sidebar.contains(e.target) && !menuBtn.contains(e.target) &&
          !$("#app").classList.contains("sidebar-collapsed")) {
        toggleSidebar(true);
      }
    });

    // Initial render
    if (Object.keys(state.chats).length === 0) {
      // Don't auto-create a chat; show welcome screen
      renderChatList();
      renderMessages();
    } else {
      // Switch to most recent chat
      const sorted = Object.values(state.chats).sort((a, b) => b.updatedAt - a.updatedAt);
      if (sorted.length) state.currentId = sorted[0].id;
      renderChatList();
      renderMessages();
    }

    // Default to collapsed on mobile
    if (window.innerWidth <= 768) toggleSidebar(true);

    console.log("%cSokAlike007 Hacking AI", "color:#6366f1;font-weight:bold;font-size:14px");
    console.log("Ready. Built with DevX Chat Model API.");
  }

  document.addEventListener("DOMContentLoaded", init);
})();
