(() => {
  document.documentElement.classList.add("has-motion");

  const SESSION_KEY = "ai-student-assistant-session";
  const page = document.body.dataset.page || "home";
  const requiresAuth = document.body.dataset.requiresAuth === "true";
  const requiresOwner = document.body.dataset.requiresOwner === "true";

  function escapeHtml(value) {
    return String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function getSession() {
    try {
      return JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
    } catch (error) {
      return null;
    }
  }

  function saveSession(session) {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  }

  function clearSession() {
    localStorage.removeItem(SESSION_KEY);
  }

  function normalizeNextPath(candidate) {
    if (!candidate || typeof candidate !== "string") {
      return "/dashboard.html";
    }

    if (!candidate.startsWith("/") || candidate.startsWith("//")) {
      return "/dashboard.html";
    }

    return candidate;
  }

  function setMessage(element, text, type = "") {
    if (!element) {
      return;
    }

    element.textContent = text || "";
    element.className = "message";

    if (type) {
      element.classList.add(`is-${type}`);
    }
  }

  function animateCount(element, targetValue, options = {}) {
    if (!element) {
      return;
    }

    const rawTarget = Number(targetValue);

    if (!Number.isFinite(rawTarget)) {
      element.textContent = String(targetValue ?? "");
      return;
    }

    const prefix = options.prefix || "";
    const suffix = options.suffix || "";
    const decimals = Number(options.decimals) || 0;

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const reducedValue = decimals > 0 ? rawTarget.toFixed(decimals) : String(Math.round(rawTarget));
      element.textContent = `${prefix}${reducedValue}${suffix}`;
      return;
    }

    const duration = Number(options.duration) || 1100;
    const start = performance.now();

    function step(now) {
      const progress = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      const current = rawTarget * eased;
      const value = decimals > 0 ? current.toFixed(decimals) : String(Math.round(current));
      element.textContent = `${prefix}${value}${suffix}`;

      if (progress < 1) {
        requestAnimationFrame(step);
      } else {
        const finalValue = decimals > 0 ? rawTarget.toFixed(decimals) : String(Math.round(rawTarget));
        element.textContent = `${prefix}${finalValue}${suffix}`;
      }
    }

    requestAnimationFrame(step);
  }

  function initRevealAnimations() {
    const elements = Array.from(document.querySelectorAll(".reveal"));

    if (!elements.length) {
      return;
    }

    elements.forEach((element) => {
      const delay = Number(element.dataset.revealDelay || 0);
      element.style.setProperty("--reveal-delay", `${delay}ms`);
    });

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || !("IntersectionObserver" in window)) {
      elements.forEach((element) => element.classList.add("is-visible"));
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) {
            return;
          }

          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        });
      },
      {
        threshold: 0.2,
        rootMargin: "0px 0px -8% 0px",
      }
    );

    elements.forEach((element) => observer.observe(element));
  }

  function initCountUps() {
    const counters = Array.from(document.querySelectorAll("[data-count-to]"));

    if (!counters.length) {
      return;
    }

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || !("IntersectionObserver" in window)) {
      counters.forEach((element) => {
        animateCount(element, Number(element.dataset.countTo || 0), {
          prefix: element.dataset.countPrefix || "",
          suffix: element.dataset.countSuffix || "",
        });
      });
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting || entry.target.dataset.counted === "true") {
            return;
          }

          entry.target.dataset.counted = "true";
          animateCount(entry.target, Number(entry.target.dataset.countTo || 0), {
            prefix: entry.target.dataset.countPrefix || "",
            suffix: entry.target.dataset.countSuffix || "",
          });
          observer.unobserve(entry.target);
        });
      },
      {
        threshold: 0.45,
      }
    );

    counters.forEach((element) => observer.observe(element));
  }

  function initMagneticButtons() {
    if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
      return;
    }

    document.querySelectorAll(".button, .outline-button, .ghost-button").forEach((button) => {
      if (button.dataset.magneticBound === "true") {
        return;
      }

      button.dataset.magneticBound = "true";

      button.addEventListener("pointermove", (event) => {
        const rect = button.getBoundingClientRect();
        const offsetX = event.clientX - rect.left;
        const offsetY = event.clientY - rect.top;
        const moveX = ((offsetX / rect.width) - 0.5) * 10;
        const moveY = ((offsetY / rect.height) - 0.5) * 8;

        button.style.setProperty("--button-x", `${moveX}px`);
        button.style.setProperty("--button-y", `${moveY}px`);
        button.style.setProperty("--pointer-x", `${offsetX}px`);
        button.style.setProperty("--pointer-y", `${offsetY}px`);
      });

      button.addEventListener("pointerleave", () => {
        button.style.setProperty("--button-x", "0px");
        button.style.setProperty("--button-y", "0px");
      });
    });
  }

  async function apiRequest(url, options = {}) {
    const session = getSession();
    const headers = {
      ...(options.headers || {}),
    };

    if (!(options.body instanceof FormData)) {
      headers["Content-Type"] = headers["Content-Type"] || "application/json";
    }

    if (session && session.token) {
      headers.Authorization = `Bearer ${session.token}`;
    }

    const response = await fetch(url, {
      ...options,
      headers,
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.error || "Something went wrong.");
    }

    return data;
  }

  function redirectToLogin() {
    const next = encodeURIComponent(`${location.pathname}${location.search}`);
    location.href = `/login.html?next=${next}`;
  }

  function redirectToDashboard() {
    location.href = "/dashboard.html";
  }

  function renderShell() {
    const session = getSession();
    const navTarget = document.querySelector("[data-nav]");
    const footerTarget = document.querySelector("[data-footer]");
    const primaryLinks = [
      { key: "home", label: "Home", href: "/index.html" },
      { key: "dashboard", label: "Dashboard", href: "/dashboard.html" },
      { key: "chatbot", label: "Chatbot", href: "/chatbot.html" },
      { key: "quiz", label: "Quiz", href: "/quiz.html" },
      { key: "summarizer", label: "Summarizer", href: "/summarizer.html" },
      { key: "about", label: "About", href: "/about.html" },
      { key: "contact", label: "Contact", href: "/contact.html" },
    ];
    const visibleLinks =
      session && session.user && session.user.isOwner
        ? [...primaryLinks.slice(0, 2), { key: "admin", label: "Owner Analytics", href: "/admin.html" }, ...primaryLinks.slice(2)]
        : primaryLinks;

    if (navTarget) {
      navTarget.innerHTML = `
        <header class="site-nav">
          <div class="container site-nav__row">
            <a class="brand" href="/index.html" aria-label="AI Student Assistant home">
              <span class="brand-mark">AI</span>
              <span>AI Student Assistant</span>
            </a>

            <button class="nav-toggle" type="button" aria-label="Open navigation" data-nav-toggle>
              <span>Menu</span>
            </button>

            <div class="site-nav__menu" data-nav-menu>
              <nav class="site-nav__links" aria-label="Primary navigation">
                ${visibleLinks
                  .map(
                    (link) => `
                      <a class="nav-link ${page === link.key ? "is-active" : ""}" href="${link.href}">
                        ${link.label}
                      </a>
                    `
                  )
                  .join("")}
              </nav>

              <div class="site-nav__actions">
                ${
                  session && session.user
                    ? `
                      <span class="nav-link">Hi, ${escapeHtml(session.user.name.split(" ")[0])}</span>
                      <button class="ghost-button" type="button" data-logout>Logout</button>
                    `
                    : `
                      <a class="nav-link ${page === "login" ? "is-active" : ""}" href="/login.html">Login</a>
                      <a class="button" href="/signup.html">Signup</a>
                    `
                }
              </div>
            </div>
          </div>
        </header>
      `;
    }

    if (footerTarget) {
      footerTarget.innerHTML = `
        <footer class="site-footer">
          <div class="container">
            <div class="site-footer__card">
              <div>
                <strong>AI Student Assistant</strong>
                <div class="muted">A simple study workspace for asking doubts, summarizing notes, and practicing with quizzes.</div>
              </div>

              <div class="footer-links">
                <a href="/index.html">Home</a>
                <a href="/dashboard.html">Dashboard</a>
                ${session && session.user && session.user.isOwner ? '<a href="/admin.html">Owner Analytics</a>' : ""}
                <a href="/about.html">About</a>
                <a href="/contact.html">Contact</a>
              </div>
            </div>
          </div>
        </footer>
      `;
    }
  }

  function bindCommonActions() {
    const toggle = document.querySelector("[data-nav-toggle]");
    const menu = document.querySelector("[data-nav-menu]");

    if (toggle && menu) {
      toggle.addEventListener("click", () => {
        menu.classList.toggle("is-open");
      });
    }

    document.querySelectorAll("[data-logout]").forEach((button) => {
      button.addEventListener("click", async (event) => {
        event.preventDefault();
        const session = getSession();

        try {
          if (session && session.token) {
            await apiRequest("/api/auth/logout", { method: "POST" });
          }
        } catch (error) {
          // Ignore logout failures and clear the local session anyway.
        }

        clearSession();
        location.href = "/login.html";
      });
    });
  }

  function applyOwnerVisibility() {
    const session = getSession();
    const isOwner = Boolean(session && session.user && session.user.isOwner);

    document.querySelectorAll("[data-owner-only]").forEach((element) => {
      element.hidden = !isOwner;
    });
  }

  async function refreshSession() {
    const session = getSession();

    if (!session || !session.token) {
      return null;
    }

    try {
      const data = await apiRequest("/api/auth/me");
      const nextSession = { token: session.token, user: data.user };
      saveSession(nextSession);
      return nextSession;
    } catch (error) {
      clearSession();

      if (requiresAuth) {
        redirectToLogin();
      }

      return null;
    }
  }

  function hydrateDashboard() {
    const greeting = document.getElementById("dashboardGreeting");
    const nameTarget = document.querySelectorAll("[data-user-name]");
    const session = getSession();
    const userName = session && session.user ? session.user.name : "Student";

    if (greeting) {
      greeting.textContent = `Welcome back, ${userName}. Ready for your next study session?`;
    }

    nameTarget.forEach((node) => {
      node.textContent = userName;
    });
  }

  function initLoginPage() {
    const form = document.getElementById("loginForm");
    const message = document.getElementById("loginMessage");

    if (!form) {
      return;
    }

    if (getSession()) {
      location.href = "/dashboard.html";
      return;
    }

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const submitButton = form.querySelector('button[type="submit"]');
      const email = document.getElementById("loginEmail").value.trim();
      const password = document.getElementById("loginPassword").value;

      setMessage(message, "Logging you in...");
      submitButton.disabled = true;

      try {
        const data = await apiRequest("/api/auth/login", {
          method: "POST",
          body: JSON.stringify({ email, password }),
        });

        saveSession(data);
        setMessage(message, "Login successful. Redirecting...", "success");

        const next = normalizeNextPath(new URLSearchParams(location.search).get("next"));
        location.href = next;
      } catch (error) {
        setMessage(message, error.message, "error");
      } finally {
        submitButton.disabled = false;
      }
    });
  }

  function initSignupPage() {
    const form = document.getElementById("signupForm");
    const message = document.getElementById("signupMessage");

    if (!form) {
      return;
    }

    if (getSession()) {
      location.href = "/dashboard.html";
      return;
    }

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const submitButton = form.querySelector('button[type="submit"]');
      const name = document.getElementById("signupName").value.trim();
      const email = document.getElementById("signupEmail").value.trim();
      const password = document.getElementById("signupPassword").value;

      setMessage(message, "Creating your account...");
      submitButton.disabled = true;

      try {
        const data = await apiRequest("/api/auth/signup", {
          method: "POST",
          body: JSON.stringify({ name, email, password }),
        });

        saveSession(data);
        setMessage(message, "Account created. Redirecting to your dashboard...", "success");
        location.href = "/dashboard.html";
      } catch (error) {
        setMessage(message, error.message, "error");
      } finally {
        submitButton.disabled = false;
      }
    });
  }

  function initDashboardPage() {
    const logoutButton = document.getElementById("dashboardLogout");

    if (logoutButton) {
      logoutButton.addEventListener("click", () => {
        const sharedLogoutButton = document.querySelector("[data-logout]");

        if (sharedLogoutButton) {
          sharedLogoutButton.click();
        }
      });
    }

    hydrateDashboard();
  }

  function initContactPage() {
    const form = document.getElementById("contactForm");
    const message = document.getElementById("contactMessage");

    if (!form || !message) {
      return;
    }

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const email = document.getElementById("contactEmail").value.trim();
      const notes = document.getElementById("contactNotes").value.trim();

      if (!email || !notes) {
        setMessage(message, "Please fill in both the email and message fields.", "error");
        return;
      }

      setMessage(message, "Thanks for reaching out. Your message has been recorded for follow-up.", "success");
      form.reset();
    });
  }

  async function init() {
    if (requiresAuth && !(getSession() && getSession().token)) {
      redirectToLogin();
      return;
    }

    renderShell();
    bindCommonActions();
    const refreshedSession = await refreshSession();

    if (requiresOwner) {
      const ownerSession = refreshedSession || getSession();

      if (!(ownerSession && ownerSession.user && ownerSession.user.isOwner)) {
        redirectToDashboard();
        return;
      }
    }

    renderShell();
    bindCommonActions();
    applyOwnerVisibility();
    initRevealAnimations();
    initCountUps();
    initMagneticButtons();
    hydrateDashboard();
    initLoginPage();
    initSignupPage();
    initDashboardPage();
    initContactPage();
  }

  window.StudyAssistantApp = {
    apiRequest,
    clearSession,
    escapeHtml,
    getSession,
    saveSession,
    setMessage,
    animateCount,
  };

  init();
})();
