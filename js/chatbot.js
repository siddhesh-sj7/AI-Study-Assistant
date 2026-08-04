(() => {
  const app = window.StudyAssistantApp;

  if (!app || document.body.dataset.page !== "chatbot") {
    return;
  }

  const form = document.getElementById("chatForm");
  const input = document.getElementById("chatInput");
  const messages = document.getElementById("chatMessages");
  const clearButton = document.getElementById("clearChat");
  const status = document.getElementById("chatStatus");
  const conversation = [];

  function renderMessage(role, text, options = {}) {
    const row = document.createElement("div");
    row.className = `chat-row ${role === "user" ? "is-user" : "is-assistant"} is-visible`;
    row.innerHTML = `<div class="chat-bubble ${options.pending ? "is-pending" : ""}">${app.escapeHtml(text)}</div>`;
    messages.appendChild(row);
    messages.scrollTop = messages.scrollHeight;
    return row;
  }

  function seedConversation() {
    messages.innerHTML = "";
    conversation.length = 0;
    const welcome =
      "Hi. I can help you with concepts, revision methods, quick explanations, and simple study plans. Ask me what you are learning.";
    conversation.push({ role: "assistant", content: welcome });
    renderMessage("assistant", welcome);
    app.setMessage(status, "Ask a doubt, request a study tip, or paste a small concept question.");
  }

  async function sendMessage(event) {
    event.preventDefault();
    const userText = input.value.trim();

    if (!userText) {
      app.setMessage(status, "Please type a question first.", "error");
      return;
    }

    conversation.push({ role: "user", content: userText });
    renderMessage("user", userText);
    input.value = "";
    app.setMessage(status, "Thinking...");
    const pendingRow = renderMessage("assistant", "Thinking...", { pending: true });
    const pendingBubble = pendingRow.querySelector(".chat-bubble");

    const submitButton = form.querySelector('button[type="submit"]');
    submitButton.disabled = true;
    clearButton.disabled = true;

    try {
      const response = await app.apiRequest("/api/chat", {
        method: "POST",
        body: JSON.stringify({
          message: userText,
          history: conversation,
        }),
      });

      conversation.push({ role: "assistant", content: response.reply });
      if (pendingBubble) {
        pendingBubble.classList.remove("is-pending");
        pendingBubble.textContent = response.reply;
      } else {
        renderMessage("assistant", response.reply);
      }
      app.setMessage(status, "Response ready.");
    } catch (error) {
      if (pendingRow) {
        pendingRow.remove();
      }
      app.setMessage(status, error.message, "error");
    } finally {
      submitButton.disabled = false;
      clearButton.disabled = false;
      input.focus();
    }
  }

  form.addEventListener("submit", sendMessage);
  clearButton.addEventListener("click", seedConversation);
  seedConversation();
})();
