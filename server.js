require("dotenv").config();

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const OpenAI = require("openai");

let mongoose = null;

try {
  mongoose = require("mongoose");
} catch (error) {
  console.warn("Mongoose is not installed yet. Falling back to in-memory user storage.");
}

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = String(process.env.HOST || "0.0.0.0").trim() || "0.0.0.0";
const DATA_DIR = path.join(__dirname, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3.2:3b";
const OLLAMA_KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE || "30m";
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS) || 45000;
const AI_PROVIDER = (process.env.AI_PROVIDER || "").trim().toLowerCase();
const OWNER_EMAILS = String(process.env.OWNER_EMAILS || "")
  .split(",")
  .map((email) => normalizeEmail(email))
  .filter(Boolean);
const aiStatusCache = {
  value: null,
  checkedAt: 0,
};

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use("/css", express.static(path.join(__dirname, "css")));
app.use("/js", express.static(path.join(__dirname, "js")));
app.use(express.static(path.join(__dirname, "public")));

const memoryUsers = new Map();
const sessions = new Map();
let fileUsersLoaded = false;

let mongoReady = false;
let UserModel = null;

if (mongoose) {
  const userSchema = new mongoose.Schema(
    {
      name: { type: String, required: true, trim: true },
      email: { type: String, required: true, unique: true, lowercase: true, trim: true },
      passwordHash: { type: String, required: true },
    },
    {
      timestamps: true,
    }
  );

  UserModel = mongoose.models.User || mongoose.model("User", userSchema);
}

const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadFileUsers() {
  if (fileUsersLoaded) {
    return;
  }

  ensureDataDir();

  if (!fs.existsSync(USERS_FILE)) {
    fs.writeFileSync(USERS_FILE, "[]", "utf8");
  }

  try {
    const raw = fs.readFileSync(USERS_FILE, "utf8");
    const users = JSON.parse(raw);

    for (const user of Array.isArray(users) ? users : []) {
      if (user && user.email) {
        memoryUsers.set(user.email, user);
      }
    }
  } catch (error) {
    fs.writeFileSync(USERS_FILE, "[]", "utf8");
  }

  fileUsersLoaded = true;
}

function saveFileUsers() {
  ensureDataDir();
  const users = Array.from(memoryUsers.values()).sort((left, right) => left.email.localeCompare(right.email));
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), "utf8");
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function sanitizeText(value) {
  return String(value || "").trim();
}

function getNetworkUrls(port, host) {
  const urls = [`http://localhost:${port}`];
  const normalizedHost = String(host || "").trim().toLowerCase();

  if (normalizedHost && !["0.0.0.0", "::", "localhost", "127.0.0.1"].includes(normalizedHost)) {
    urls.push(`http://${host}:${port}`);
    return urls;
  }

  const interfaces = os.networkInterfaces();
  const seen = new Set(urls);

  for (const network of Object.values(interfaces)) {
    for (const details of network || []) {
      if (!details || details.family !== "IPv4" || details.internal) {
        continue;
      }

      const url = `http://${details.address}:${port}`;

      if (!seen.has(url)) {
        seen.add(url);
        urls.push(url);
      }
    }
  }

  return urls;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${derived}`;
}

function verifyPassword(password, storedHash) {
  const [salt, originalHash] = String(storedHash || "").split(":");

  if (!salt || !originalHash) {
    return false;
  }

  const candidateHash = crypto.scryptSync(password, salt, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(originalHash, "hex"), Buffer.from(candidateHash, "hex"));
}

function publicUser(user) {
  return {
    id: String(user._id || user.id),
    name: user.name,
    email: user.email,
    isOwner: isOwnerUser(user),
  };
}

function createSession(user) {
  const token = crypto.randomBytes(24).toString("hex");
  const safeUser = publicUser(user);
  sessions.set(token, safeUser);
  return { token, user: safeUser };
}

async function findUserByEmail(email) {
  if (mongoReady && UserModel) {
    return UserModel.findOne({ email }).lean();
  }

  loadFileUsers();
  return memoryUsers.get(email) || null;
}

async function createUserRecord({ name, email, passwordHash }) {
  if (mongoReady && UserModel) {
    const created = await UserModel.create({ name, email, passwordHash });
    return created.toObject();
  }

  const user = {
    id: crypto.randomUUID(),
    name,
    email,
    passwordHash,
    createdAt: new Date().toISOString(),
  };

  loadFileUsers();
  memoryUsers.set(email, user);
  saveFileUsers();
  return user;
}

async function getAllUsers() {
  if (mongoReady && UserModel) {
    return UserModel.find({})
      .sort({ createdAt: -1 })
      .lean();
  }

  loadFileUsers();
  return Array.from(memoryUsers.values()).sort((left, right) => {
    return new Date(right.createdAt || 0).getTime() - new Date(left.createdAt || 0).getTime();
  });
}

function formatUserForAdmin(user) {
  const createdAt = user.createdAt instanceof Date ? user.createdAt.toISOString() : user.createdAt || null;

  return {
    id: String(user._id || user.id),
    name: user.name,
    email: user.email,
    createdAt,
  };
}

function authMiddleware(req, res, next) {
  const authHeader = req.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  if (!token || !sessions.has(token)) {
    return res.status(401).json({ error: "Please log in to continue." });
  }

  req.user = sessions.get(token);
  req.token = token;
  next();
}

function isOwnerUser(user) {
  const email = normalizeEmail(user && user.email);
  return Boolean(email) && OWNER_EMAILS.includes(email);
}

function ownerMiddleware(req, res, next) {
  if (!isOwnerUser(req.user)) {
    return res.status(403).json({ error: "Owner access only." });
  }

  next();
}

function extractKeywords(text, limit = 5) {
  const stopWords = new Set([
    "about",
    "after",
    "again",
    "being",
    "below",
    "could",
    "every",
    "first",
    "found",
    "great",
    "have",
    "into",
    "might",
    "other",
    "should",
    "their",
    "there",
    "these",
    "thing",
    "those",
    "under",
    "using",
    "where",
    "which",
    "while",
    "would",
    "your",
  ]);

  const counts = new Map();
  const words = sanitizeText(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 3 && !stopWords.has(word));

  for (const word of words) {
    counts.set(word, (counts.get(word) || 0) + 1);
  }

  return Array.from(counts.entries())
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([word]) => word);
}

function summarizeLocally(notes) {
  const cleaned = sanitizeText(notes).replace(/\s+/g, " ");

  if (!cleaned) {
    return {
      summary: "",
      bullets: [],
    };
  }

  const sentences = cleaned
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

  const keywords = extractKeywords(cleaned, 6);

  const scored = sentences.map((sentence, index) => {
    const score = keywords.reduce((total, keyword) => total + (sentence.toLowerCase().includes(keyword) ? 1 : 0), 0);
    return { sentence, index, score };
  });

  const chosen = scored
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, Math.min(Math.max(3, Math.ceil(sentences.length / 3)), 5))
    .sort((left, right) => left.index - right.index)
    .map((item) => item.sentence);

  const bullets = chosen.map((sentence) => sentence.replace(/\s+/g, " ").trim());
  const summary = bullets.slice(0, 2).join(" ");

  return {
    summary,
    bullets,
  };
}

function buildChatFallback(message) {
  const prompt = sanitizeText(message).toLowerCase();
  const keywords = extractKeywords(message, 3);
  const topicText = keywords.length ? keywords.join(", ") : "your topic";

  if (prompt.includes("quiz")) {
    return "Open the quiz tool, enter the topic, and generate 5 MCQs. After answering, check the explanations and rewrite any wrong answers in your own words.";
  }

  if (prompt.includes("summary") || prompt.includes("summarize")) {
    return "Paste the notes into the summarizer and focus on the key points first. Once the short recap looks right, turn those points into flashcards or a short quiz.";
  }

  if (prompt.includes("plan") || prompt.includes("schedule")) {
    return "A simple study plan is: 20 minutes to review concepts, 20 minutes for practice, and 10 minutes to correct mistakes. Repeat that block for the hardest parts first.";
  }

  return `Here is a simple way to study ${topicText}: start with the definition, list the main ideas, solve one small example, and then explain it back in your own words.`;
}

function buildDifferenceReply(prompt) {
  if (prompt.includes("compiler") && prompt.includes("interpreter")) {
    return "A compiler translates the full program before execution and usually creates an executable file. An interpreter translates and runs code line by line, so it is easier for testing but usually slower.";
  }

  if (prompt.includes("html") && prompt.includes("css")) {
    return "HTML gives structure to a webpage, like headings, paragraphs, and buttons. CSS styles that structure by controlling colors, spacing, layout, and animations.";
  }

  if (prompt.includes("stack") && prompt.includes("queue")) {
    return "A stack follows LIFO, so the last item added is the first removed. A queue follows FIFO, so the first item added is the first removed.";
  }

  if (prompt.includes("dbms") && prompt.includes("file system")) {
    return "A DBMS stores data in an organized, queryable, and secure way, while a file system stores raw files without strong relationships, SQL queries, or advanced data control.";
  }

  return null;
}

function findTopicInfo(prompt) {
  const topics = [
    {
      label: "DBMS",
      aliases: ["dbms", "database management system", "database"],
      definition: "software used to store, organize, update, and retrieve data efficiently",
      why: "helps keep data secure, consistent, and easy to manage",
      uses: ["student record systems", "banking apps", "e-commerce websites"],
      example: "a college portal storing student details, marks, and attendance",
    },
    {
      label: "Machine learning",
      aliases: ["machine learning", "ml"],
      definition: "a part of AI where systems learn patterns from data to make predictions or decisions",
      why: "helps computers improve results without being manually programmed for every case",
      uses: ["spam filtering", "recommendation systems", "image recognition"],
      example: "Netflix suggesting movies based on what you watched before",
    },
    {
      label: "Operating system",
      aliases: ["operating system", " os ", "os"],
      definition: "the main software that manages hardware, memory, files, and running programs",
      why: "acts as the bridge between the user, applications, and hardware",
      uses: ["process management", "memory management", "file handling"],
      example: "Windows managing apps, files, and devices on a laptop",
    },
    {
      label: "Normalization",
      aliases: ["normalization", "normalisation"],
      definition: "a database design process used to reduce duplicate data and improve consistency",
      why: "makes tables cleaner, easier to update, and less likely to create anomalies",
      uses: ["removing repeated data", "splitting tables logically", "improving consistency"],
      example: "keeping student details in one table and course details in another instead of repeating both everywhere",
    },
    {
      label: "Object-oriented programming",
      aliases: ["oops", "object oriented", "object-oriented", "oop"],
      definition: "a programming style that organizes code into classes and objects",
      why: "makes code easier to reuse, maintain, and model like real-world entities",
      uses: ["encapsulation", "inheritance", "polymorphism"],
      example: "a Student class with name, roll number, and methods like enroll()",
    },
    {
      label: "JavaScript",
      aliases: ["javascript", " js "],
      definition: "a programming language used to add interactivity and logic to web pages",
      why: "helps websites respond to user actions like clicks, form input, and dynamic updates",
      uses: ["form validation", "dynamic content", "interactive buttons"],
      example: "showing an error if a login form is submitted with an empty password",
    },
    {
      label: "HTML",
      aliases: ["html"],
      definition: "the markup language used to structure web pages",
      why: "defines what appears on the page, such as headings, text, links, and forms",
      uses: ["page structure", "forms", "links and media"],
      example: "using h1, p, img, and form tags to build a page",
    },
    {
      label: "CSS",
      aliases: ["css"],
      definition: "the stylesheet language used to design and style web pages",
      why: "controls the visual look of the page, including colors, spacing, layout, and animation",
      uses: ["colors", "layout", "animations"],
      example: "making a button glow on hover and cards animate on scroll",
    },
    {
      label: "Computer network",
      aliases: ["computer network", "networking", "network"],
      definition: "a group of connected devices that share data and resources",
      why: "allows communication, file sharing, and internet access between devices",
      uses: ["LAN", "WAN", "resource sharing"],
      example: "computers in a college lab sharing one network printer and internet connection",
    },
    {
      label: "API",
      aliases: ["api", "application programming interface"],
      definition: "a set of rules that lets one software application talk to another",
      why: "allows systems to exchange data and services without exposing their full internal code",
      uses: ["login systems", "payment gateways", "chat integrations"],
      example: "a website sending a request to a weather API and showing the result",
    },
    {
      label: "Cloud computing",
      aliases: ["cloud computing", "cloud"],
      definition: "using internet-based servers and services instead of only local machines",
      why: "makes storage, hosting, and computing resources available on demand",
      uses: ["online storage", "hosting apps", "remote databases"],
      example: "storing project files on Google Drive instead of only on one laptop",
    },
    {
      label: "Stack",
      aliases: ["stack"],
      definition: "a linear data structure that follows Last In First Out",
      why: "is useful when the most recently added item should be removed first",
      uses: ["undo operations", "function calls", "expression evaluation"],
      example: "a pile of plates where the top plate is removed first",
    },
    {
      label: "Queue",
      aliases: ["queue"],
      definition: "a linear data structure that follows First In First Out",
      why: "is useful when items should be processed in the same order they arrive",
      uses: ["printer jobs", "task scheduling", "customer service lines"],
      example: "students standing in a line where the first person is served first",
    },
  ];

  return topics.find((topic) =>
    topic.aliases.some((alias) => {
      if (alias.trim() === "os") {
        return /\bos\b/.test(prompt);
      }

      if (alias.trim() === "js") {
        return /\bjs\b/.test(prompt);
      }

      return prompt.includes(alias);
    })
  );
}

function buildTopicReply(prompt, topic) {
  const wantsExample = prompt.includes("example") || prompt.includes("real life") || prompt.includes("real-life");
  const wantsUses = prompt.includes("use") || prompt.includes("application");
  const wantsAdvantages = prompt.includes("advantage") || prompt.includes("benefit") || prompt.includes("importance");

  if (wantsAdvantages) {
    return `${topic.label} is important because it ${topic.why}. It is useful in ${topic.uses.slice(0, 2).join(" and ")}.`;
  }

  if (wantsUses) {
    return `${topic.label} is commonly used for ${topic.uses.join(", ")}. Example: ${topic.example}.`;
  }

  if (wantsExample) {
    return `${topic.label} is ${topic.definition}. A simple example is ${topic.example}.`;
  }

  return `${topic.label} is ${topic.definition}. It ${topic.why}. Example: ${topic.example}.`;
}

function buildQuizFallback(topic) {
  const safeTopic = sanitizeText(topic) || "the topic";

  return [
    {
      question: `Which study action best helps you understand the core idea of ${safeTopic}?`,
      options: [
        `Write a one-line definition of ${safeTopic} and one example.`,
        "Skip the basics and memorize random facts first.",
        "Study only the longest chapter without taking notes.",
        "Avoid checking whether you understood the topic.",
      ],
      answerIndex: 0,
      explanation: `Starting with a definition and example gives you a strong base for ${safeTopic}.`,
    },
    {
      question: `What is the best way to revise ${safeTopic} after reading your notes once?`,
      options: [
        "Close the notes and recall the key points from memory.",
        "Read the same paragraph repeatedly without testing yourself.",
        "Only highlight lines without reviewing them later.",
        "Move to a new topic immediately and never return.",
      ],
      answerIndex: 0,
      explanation: "Active recall is one of the fastest ways to strengthen memory.",
    },
    {
      question: `When solving questions on ${safeTopic}, what should you do after getting one wrong?`,
      options: [
        "Ignore the mistake and continue.",
        "Review why the answer was wrong and note the correct reasoning.",
        "Memorize the final answer without understanding it.",
        "Stop practicing for the day.",
      ],
      answerIndex: 1,
      explanation: "Mistake review is where most learning happens during practice.",
    },
    {
      question: `Which output shows a deeper understanding of ${safeTopic}?`,
      options: [
        "Copying the topic title exactly as written.",
        "Listing unrelated facts from other chapters.",
        "Explaining the idea in simple words and connecting it to a use case.",
        "Reading the same note silently without reflection.",
      ],
      answerIndex: 2,
      explanation: "If you can explain it simply and connect it to a real use case, you usually understand it well.",
    },
    {
      question: `What should be your final step after revising ${safeTopic}?`,
      options: [
        "Forget the topic until the exam.",
        "Take a short self-test and record weak areas.",
        "Only redesign your notes without checking knowledge.",
        "Change topics every five minutes.",
      ],
      answerIndex: 1,
      explanation: "A short test helps you measure understanding and plan the next revision.",
    },
  ];
}

function buildFastChatReply(message) {
  const prompt = sanitizeText(message).toLowerCase();

  if (!prompt) {
    return null;
  }

  if (prompt.includes("quiz")) {
    return "Open the quiz tool, enter your topic, generate MCQs, answer them, and then review the explanations for any wrong answers. That gives you quick practice plus revision in one flow.";
  }

  if (prompt.includes("summary") || prompt.includes("summarize")) {
    return "Paste your notes into the summarizer, read the short recap first, and then revise the bullet points. After that, test yourself with the quiz tool on the same topic.";
  }

  if (prompt.includes("study plan") || prompt.includes("study schedule") || prompt.includes("how do i study")) {
    return "Use a simple 50-minute plan: 20 minutes to understand the concept, 15 minutes to revise notes, and 15 minutes to solve questions. Repeat that for your hardest topic first.";
  }

  const differenceReply = buildDifferenceReply(prompt);

  if (differenceReply) {
    return differenceReply;
  }

  const topic = findTopicInfo(prompt);

  if (topic) {
    return buildTopicReply(prompt, topic);
  }

  if (prompt.startsWith("what is ") || prompt.startsWith("define ") || prompt.startsWith("explain ")) {
    const keywords = extractKeywords(message, 2);
    const topicText = keywords.length ? keywords.join(" ") : "this topic";
    return `${topicText[0] ? topicText[0].toUpperCase() + topicText.slice(1) : "This topic"} should be understood in three steps: learn the definition, note the main points, and connect it to one small example. After that, try one quiz question to check your understanding.`;
  }

  if (prompt.includes("difference between")) {
    return "Mention the two exact concepts you want to compare, and I will explain the difference in simple points with one example.";
  }

  return null;
}

function buildTopicQuiz(topicKey, topicLabel) {
  const quizBank = {
    dbms: [
      {
        question: "What is the main purpose of a DBMS?",
        options: [
          "To store, manage, and retrieve data efficiently",
          "To create only hardware components",
          "To design computer networks only",
          "To replace the operating system",
        ],
        answerIndex: 0,
        explanation: "A DBMS is mainly used to store, organize, and retrieve data efficiently.",
      },
      {
        question: "Which language is commonly used to query databases?",
        options: ["SQL", "HTML", "CSS", "C"],
        answerIndex: 0,
        explanation: "SQL is the standard language used to query and manage relational databases.",
      },
      {
        question: "What does normalization help reduce in a database?",
        options: ["Data redundancy", "Network speed", "CPU heat", "Monitor size"],
        answerIndex: 0,
        explanation: "Normalization reduces duplicate data and improves consistency.",
      },
      {
        question: "Which of these is an example of a DBMS?",
        options: ["MySQL", "Photoshop", "Chrome", "PowerPoint"],
        answerIndex: 0,
        explanation: "MySQL is a database management system.",
      },
      {
        question: "A primary key is used to:",
        options: [
          "Uniquely identify each record in a table",
          "Decorate a webpage",
          "Start the computer",
          "Connect to Wi-Fi",
        ],
        answerIndex: 0,
        explanation: "A primary key uniquely identifies each record in a table.",
      },
    ],
    javascript: [
      {
        question: "What is JavaScript mainly used for on web pages?",
        options: [
          "Adding interactivity and logic",
          "Creating only database tables",
          "Replacing all HTML tags",
          "Formatting only printer output",
        ],
        answerIndex: 0,
        explanation: "JavaScript adds interactivity and dynamic behavior to web pages.",
      },
      {
        question: "Which keyword is used to declare a block-scoped variable?",
        options: ["let", "table", "style", "select"],
        answerIndex: 0,
        explanation: "`let` creates a block-scoped variable in JavaScript.",
      },
      {
        question: "What does the DOM represent?",
        options: [
          "Document Object Model",
          "Data Output Machine",
          "Dynamic Office Method",
          "Digital Object Manager",
        ],
        answerIndex: 0,
        explanation: "DOM stands for Document Object Model.",
      },
      {
        question: "Which symbol is used for strict equality in JavaScript?",
        options: ["===", "=", "=>", "!="],
        answerIndex: 0,
        explanation: "`===` checks both value and type.",
      },
      {
        question: "Which event is triggered when a button is clicked?",
        options: ["click", "hover", "submitdata", "keypressonly"],
        answerIndex: 0,
        explanation: "The `click` event runs when a button is clicked.",
      },
    ],
    machine_learning: [
      {
        question: "Machine learning is a part of:",
        options: ["Artificial Intelligence", "HTML", "Computer hardware", "MS Word"],
        answerIndex: 0,
        explanation: "Machine learning is a subfield of artificial intelligence.",
      },
      {
        question: "What does a machine learning model learn from?",
        options: ["Data", "Paint", "Keyboards", "Printers"],
        answerIndex: 0,
        explanation: "Machine learning models learn patterns from data.",
      },
      {
        question: "Which of these is a real use of machine learning?",
        options: ["Spam filtering", "Charging a battery", "Printing paper", "Installing fans"],
        answerIndex: 0,
        explanation: "Spam filters commonly use machine learning.",
      },
      {
        question: "In supervised learning, the training data is:",
        options: ["Labeled", "Invisible", "Broken", "Only audio"],
        answerIndex: 0,
        explanation: "Supervised learning uses labeled data.",
      },
      {
        question: "A prediction model usually tries to find:",
        options: ["Patterns", "Screws", "Paint colors", "Keyboard shortcuts only"],
        answerIndex: 0,
        explanation: "Machine learning models identify patterns to make predictions.",
      },
    ],
    operating_system: [
      {
        question: "What is the main role of an operating system?",
        options: [
          "Manage hardware and software resources",
          "Only play music files",
          "Design websites automatically",
          "Replace database software",
        ],
        answerIndex: 0,
        explanation: "An operating system manages hardware, memory, files, and running programs.",
      },
      {
        question: "Which of these is an operating system?",
        options: ["Linux", "SQL", "HTML", "Photoshop"],
        answerIndex: 0,
        explanation: "Linux is an operating system.",
      },
      {
        question: "RAM management is mainly handled by the:",
        options: ["Operating system", "Keyboard", "Monitor", "Speaker"],
        answerIndex: 0,
        explanation: "The operating system manages memory usage.",
      },
      {
        question: "File management in a computer is handled by the:",
        options: ["Operating system", "Only browser", "Mouse", "Printer"],
        answerIndex: 0,
        explanation: "The operating system handles file creation, storage, and access.",
      },
      {
        question: "Which feature allows multiple programs to run one after another very quickly?",
        options: ["Multitasking", "Formatting", "Animation", "Scanning"],
        answerIndex: 0,
        explanation: "Multitasking allows the operating system to manage multiple running programs.",
      },
    ],
    html: [
      {
        question: "HTML is mainly used to:",
        options: ["Structure web pages", "Train AI models", "Store databases", "Create operating systems"],
        answerIndex: 0,
        explanation: "HTML provides the structure of a web page.",
      },
      {
        question: "Which tag is used for the largest heading?",
        options: ["<h1>", "<p>", "<div>", "<span>"],
        answerIndex: 0,
        explanation: "<h1> is used for the top-level heading.",
      },
      {
        question: "Which tag is used to create a hyperlink?",
        options: ["<a>", "<img>", "<ul>", "<table>"],
        answerIndex: 0,
        explanation: "<a> is used to create links.",
      },
      {
        question: "Which tag is used to insert an image?",
        options: ["<img>", "<imagebox>", "<picturetag>", "<src>"],
        answerIndex: 0,
        explanation: "<img> is used to show images in HTML.",
      },
      {
        question: "HTML stands for:",
        options: [
          "HyperText Markup Language",
          "High Transfer Machine Language",
          "Hyper Tool Managing Language",
          "Home Text Marking Logic",
        ],
        answerIndex: 0,
        explanation: "HTML stands for HyperText Markup Language.",
      },
    ],
    css: [
      {
        question: "CSS is mainly used for:",
        options: ["Styling web pages", "Creating databases", "Managing files", "Running operating systems"],
        answerIndex: 0,
        explanation: "CSS controls the visual style of a webpage.",
      },
      {
        question: "Which property changes text color in CSS?",
        options: ["color", "font-style", "background-image", "display"],
        answerIndex: 0,
        explanation: "The `color` property sets the text color.",
      },
      {
        question: "Which CSS property changes the background color?",
        options: ["background-color", "text-color", "bgstyle", "fill"],
        answerIndex: 0,
        explanation: "`background-color` changes an element's background color.",
      },
      {
        question: "Which selector targets an element by class?",
        options: [".classname", "#classname", "classname()", "<classname>"],
        answerIndex: 0,
        explanation: "A dot selector targets a class in CSS.",
      },
      {
        question: "Which property adds space inside an element?",
        options: ["padding", "margin", "border", "height"],
        answerIndex: 0,
        explanation: "Padding adds internal space inside an element.",
      },
    ],
  };

  return quizBank[topicKey] || buildQuizFallback(topicLabel);
}

function getTopicKey(topic) {
  const normalized = sanitizeText(topic).toLowerCase();

  if (normalized.includes("dbms") || normalized.includes("database")) {
    return "dbms";
  }
  if (normalized.includes("javascript") || normalized.includes("js")) {
    return "javascript";
  }
  if (normalized.includes("machine learning") || normalized.includes("artificial intelligence") || normalized === "ai") {
    return "machine_learning";
  }
  if (normalized.includes("operating system")) {
    return "operating_system";
  }
  if (normalized === "html" || normalized.includes("html ")) {
    return "html";
  }
  if (normalized === "css" || normalized.includes("css ")) {
    return "css";
  }

  return null;
}

function stripCodeFence(text) {
  return sanitizeText(text).replace(/^```json/i, "").replace(/^```/i, "").replace(/```$/i, "").trim();
}

function extractJsonBlock(text) {
  const cleaned = stripCodeFence(text);
  const objectStart = cleaned.indexOf("{");
  const objectEnd = cleaned.lastIndexOf("}");
  const arrayStart = cleaned.indexOf("[");
  const arrayEnd = cleaned.lastIndexOf("]");

  if (objectStart !== -1 && objectEnd !== -1 && objectStart < objectEnd) {
    return cleaned.slice(objectStart, objectEnd + 1);
  }

  if (arrayStart !== -1 && arrayEnd !== -1 && arrayStart < arrayEnd) {
    return cleaned.slice(arrayStart, arrayEnd + 1);
  }

  throw new Error("Model response did not contain JSON.");
}

function parseJsonResponse(text) {
  return JSON.parse(extractJsonBlock(text));
}

async function askOpenAI({ instructions, input }) {
  if (!openai) {
    throw new Error("OpenAI API key not configured.");
  }

  const response = await openai.responses.create({
    model: process.env.OPENAI_MODEL || "gpt-5.2",
    instructions,
    input,
  });

  return sanitizeText(response.output_text);
}

async function askOllama({ prompt, format, task = "chat", timeoutMs }) {
  const taskOptions =
    task === "summary"
      ? {
          temperature: 0.1,
          num_predict: 150,
          num_ctx: 2048,
        }
      : task === "quiz"
        ? {
            temperature: 0.15,
            num_predict: 320,
            num_ctx: 2048,
          }
        : task === "warmup"
          ? {
              temperature: 0,
              num_predict: 8,
              num_ctx: 256,
            }
          : {
              temperature: 0.2,
              num_predict: 90,
              num_ctx: 1024,
            };

  const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
    method: "POST",
    signal: AbortSignal.timeout(Number(timeoutMs) || OLLAMA_TIMEOUT_MS),
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      prompt,
      stream: false,
      format,
      keep_alive: OLLAMA_KEEP_ALIVE,
      options: {
        top_p: 0.9,
        repeat_penalty: 1.05,
        ...taskOptions,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama request failed with status ${response.status}.`);
  }

  const data = await response.json();
  return sanitizeText(data.response);
}

async function detectAvailableAi() {
  if (aiStatusCache.value && Date.now() - aiStatusCache.checkedAt < 15000) {
    return aiStatusCache.value;
  }

  if (AI_PROVIDER === "fallback") {
    aiStatusCache.value = "fallback";
    aiStatusCache.checkedAt = Date.now();
    return "fallback";
  }

  if (AI_PROVIDER === "openai" && openai) {
    aiStatusCache.value = "openai";
    aiStatusCache.checkedAt = Date.now();
    return "openai";
  }

  if (AI_PROVIDER === "ollama") {
    try {
      const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
        signal: AbortSignal.timeout(1500),
      });
      if (response.ok) {
        const data = await response.json();
        if (Array.isArray(data.models) && data.models.some((model) => model.name === OLLAMA_MODEL)) {
          aiStatusCache.value = "ollama";
          aiStatusCache.checkedAt = Date.now();
          return "ollama";
        }
      }
    } catch (error) {
      aiStatusCache.value = "fallback";
      aiStatusCache.checkedAt = Date.now();
      return "fallback";
    }

    aiStatusCache.value = "fallback";
    aiStatusCache.checkedAt = Date.now();
    return "fallback";
  }

  if (openai) {
    aiStatusCache.value = "openai";
    aiStatusCache.checkedAt = Date.now();
    return "openai";
  }

  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
      signal: AbortSignal.timeout(1500),
    });
    if (response.ok) {
      const data = await response.json();
      if (Array.isArray(data.models) && data.models.some((model) => model.name === OLLAMA_MODEL)) {
        aiStatusCache.value = "ollama";
        aiStatusCache.checkedAt = Date.now();
        return "ollama";
      }
    }
  } catch (error) {
    aiStatusCache.value = "fallback";
    aiStatusCache.checkedAt = Date.now();
    return "fallback";
  }

  aiStatusCache.value = "fallback";
  aiStatusCache.checkedAt = Date.now();
  return "fallback";
}

async function warmOllamaModel() {
  const provider = await detectAvailableAi();

  if (provider !== "ollama") {
    return;
  }

  try {
    await askOllama({
      prompt: "Reply with READY only.",
      task: "warmup",
    });
    console.log(`Ollama model warmed: ${OLLAMA_MODEL}`);
  } catch (error) {
    console.warn(`Ollama warmup skipped: ${error.message}`);
  }
}

async function generateChatReply(message, history) {
  const fastReply = buildFastChatReply(message);

  if (fastReply) {
    return fastReply;
  }

  const provider = await detectAvailableAi();

  try {
    const historyText = Array.isArray(history)
      ? history
          .slice(-6)
          .map((entry) => `${entry.role}: ${entry.content}`)
          .join("\n")
      : "";

    const combinedPrompt = [
      "You are a friendly AI student assistant.",
      "Use simple English.",
      "Stay under 90 words.",
      "Give practical, accurate, student-friendly help.",
      "",
      "Conversation so far:",
      historyText || "No prior messages.",
      "",
      "Student message:",
      message,
    ].join("\n");

    const reply =
      provider === "openai"
        ? await askOpenAI({
            instructions:
              "You are a friendly AI student assistant. Respond in simple English, stay under 90 words, and give practical study help.",
            input: `Conversation so far:\n${historyText}\n\nStudent message:\n${message}`,
          })
        : provider === "ollama"
          ? await askOllama({ prompt: combinedPrompt, task: "chat", timeoutMs: 8000 })
          : "";

    return reply || buildChatFallback(message);
  } catch (error) {
    return buildChatFallback(message);
  }
}

async function generateSummary(notes) {
  const localSummary = summarizeLocally(notes);
  return localSummary;
}

async function generateQuiz(topic) {
  const topicKey = getTopicKey(topic);
  return buildTopicQuiz(topicKey, topic);
}

app.get("/api/health", async (req, res) => {
  const ai = await detectAvailableAi();

  res.json({
    ok: true,
    database: mongoReady ? "mongodb" : "file",
    ai,
    ollamaModel: OLLAMA_MODEL,
  });
});

app.post("/api/auth/signup", async (req, res) => {
  try {
    const name = sanitizeText(req.body.name);
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || "");

    if (!name || !email || !password) {
      return res.status(400).json({ error: "Name, email, and password are required." });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters long." });
    }

    const existingUser = await findUserByEmail(email);

    if (existingUser) {
      return res.status(409).json({ error: "An account with this email already exists." });
    }

    const user = await createUserRecord({
      name,
      email,
      passwordHash: hashPassword(password),
    });

    return res.status(201).json(createSession(user));
  } catch (error) {
    if (error && error.code === 11000) {
      return res.status(409).json({ error: "An account with this email already exists." });
    }

    return res.status(500).json({ error: "Unable to create your account right now." });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || "");

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required." });
    }

    const user = await findUserByEmail(email);

    if (!user || !verifyPassword(password, user.passwordHash)) {
      return res.status(401).json({ error: "Invalid email or password." });
    }

    return res.json(createSession(user));
  } catch (error) {
    return res.status(500).json({ error: "Unable to log in right now." });
  }
});

app.get("/api/auth/me", authMiddleware, (req, res) => {
  res.json({ user: req.user });
});

app.post("/api/auth/logout", authMiddleware, (req, res) => {
  sessions.delete(req.token);
  res.json({ ok: true });
});

app.get("/api/admin/overview", authMiddleware, ownerMiddleware, async (req, res) => {
  const users = (await getAllUsers()).map(formatUserForAdmin);
  const latestUser = users[0] || null;
  const ai = await detectAvailableAi();

  res.json({
    stats: {
      totalUsers: users.length,
      storageMode: mongoReady ? "MongoDB" : "Local File Storage",
      aiProvider: ai === "ollama" ? "Ollama" : ai === "openai" ? "OpenAI" : "Fallback",
      model: ai === "ollama" ? OLLAMA_MODEL : process.env.OPENAI_MODEL || "gpt-5.2",
      latestUser,
      usersFile: mongoReady ? null : USERS_FILE,
    },
    users,
  });
});

app.post("/api/chat", async (req, res) => {
  const message = sanitizeText(req.body.message);
  const history = Array.isArray(req.body.history) ? req.body.history : [];

  if (!message) {
    return res.status(400).json({ error: "Please enter a question first." });
  }

  const reply = await generateChatReply(message, history);
  return res.json({ reply });
});

app.post("/api/summarize", async (req, res) => {
  const notes = sanitizeText(req.body.notes);

  if (notes.length < 30) {
    return res.status(400).json({ error: "Please paste a little more text so the assistant can summarize it well." });
  }

  const summary = await generateSummary(notes);
  return res.json(summary);
});

app.post("/api/quiz", async (req, res) => {
  const topic = sanitizeText(req.body.topic);

  if (!topic) {
    return res.status(400).json({ error: "Enter a topic to generate a quiz." });
  }

  const questions = await generateQuiz(topic);
  return res.json({ questions });
});

app.use("/api", (req, res) => {
  res.status(404).json({ error: "API route not found." });
});

async function connectDatabase() {
  if (!mongoose || !process.env.MONGODB_URI) {
    if (!process.env.MONGODB_URI) {
      console.warn("MONGODB_URI is not configured. Using file-based user storage.");
    }

    loadFileUsers();
    return;
  }

  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 2000,
    });
    mongoReady = true;
    console.log("Connected to MongoDB.");
  } catch (error) {
    mongoReady = false;
    loadFileUsers();
    console.warn("MongoDB connection failed. Using file-based user storage instead.");
  }
}

async function startServer() {
  await connectDatabase();

  app.listen(PORT, HOST, () => {
    const urls = getNetworkUrls(PORT, HOST);
    console.log("AI Student Assistant is ready.");
    console.log(`Local: ${urls[0]}`);

    if (urls.length > 1) {
      console.log("Same Wi-Fi sharing:");

      for (const url of urls.slice(1)) {
        console.log(`  ${url}`);
      }
    }

    console.log("Use the local URL in your own browser, or a same-Wi-Fi URL for nearby devices.");
    warmOllamaModel();
  });
}

startServer();
