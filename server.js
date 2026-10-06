import express from "express";
import { exec } from "child_process";
import geminiModule from "./gemini.cjs";

const { askGemini } = geminiModule;
const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static("public"));

// ═══════════════════════════════════════
// JARVIS CORE
// ═══════════════════════════════════════

function run(command, timeout = 10000) {
  return new Promise((resolve) => {
    exec(command, { timeout }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        output: (stdout || "").trim(),
        error: (stderr || error?.message || "").trim()
      });
    });
  });
}

function reply(res, text, extra = {}) {
  return res.json({
    ok: true,
    reply: text,
    ...extra
  });
}

function has(text, words) {
  return words.some(word => text.includes(word));
}

function clean(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^\w\s:/.-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function quote(text) {
  return "'" + String(text).replace(/'/g, "'\\''") + "'";
}

// ═══════════════════════════════════════
// JARVIS SPEECH
// ═══════════════════════════════════════

async function speak(text) {
  return run(
    `termux-tts-speak ` +
    `-l en-US ` +
    `-r 0.90 ` +
    `-p 0.90 ` +
    `${quote(text)}`,
    30000
  );
}

// ═══════════════════════════════════════
// WEBSITE OPENING
// ═══════════════════════════════════════

async function openUrl(url) {
  return run(
    `am start -a android.intent.action.VIEW -d ${quote(url)}`
  );
}

// ═══════════════════════════════════════
// CURRENT TERMUX APP LAUNCHER
// ═══════════════════════════════════════
//
// This is deliberately modular.
// Later the Android companion will replace
// discovery with PackageManager.
// ═══════════════════════════════════════

const KNOWN_APPS = {
  claude: "com.anthropic.claude",
  "anthropic claude": "com.anthropic.claude",

  grok: "ai.x.grok",

  notes: "com.miui.notes",
  "mi notes": "com.miui.notes",
  "xiaomi notes": "com.miui.notes",

  termux: "com.termux"
};

async function launchPackage(packageName) {
  const result = await run(
    `am start --user 0 ` +
    `-a android.intent.action.MAIN ` +
    `-c android.intent.category.LAUNCHER ` +
    `-p ${quote(packageName)}`
  );

  return result.ok;
}

async function launchKnownApp(name) {

  const normalized = name
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

  console.log(
    `[JARVIS APP] Requested app: ${normalized}`
  );

  const packageName = KNOWN_APPS[normalized];

  if (!packageName) {
    return {
      ok: false,
      reason: "unknown",
      appName: normalized
    };
  }

  // Claude does not expose a launcher activity to Termux.
  // Its Claude URL can be launched directly inside the package.
  if (
    normalized === "claude" ||
    normalized === "anthropic claude"
  ) {

    const result = await run(
      `am start --user 0 ` +
      `-a android.intent.action.VIEW ` +
      `-d ${quote("https://claude.ai")} ` +
      `-p ${quote(packageName)}`
    );

    if (!result.ok) {
      return {
        ok: false,
        reason: "launch_failed",
        appName: normalized,
        packageName,
        error:
          result.error ||
          result.stderr ||
          "Android launch failed"
      };
    }

    return {
      ok: true,
      appName: normalized,
      packageName
    };
  }

  // All other known apps keep the existing launcher method.
  const result = await launchPackage(packageName);

  return {
    ...result,
    appName: normalized,
    packageName
  };
}

// ═══════════════════════════════════════
// TIMER MANAGEMENT
// ═══════════════════════════════════════

const timers = new Map();
let timerId = 1;

function createTimer(seconds, label) {
  const id = timerId++;

  const timeout = setTimeout(async () => {
    timers.delete(id);

    await speak(
      label
        ? `Your ${label} timer is complete.`
        : "Your timer is complete."
    );
  }, seconds * 1000);

  timers.set(id, {
    id,
    label,
    seconds,
    created: Date.now(),
    timeout
  });

  return id;
}

function cancelAllTimers() {
  for (const timer of timers.values()) {
    clearTimeout(timer.timeout);
  }

  timers.clear();
}


// ═══════════════════════════════════════
// LOCAL FILE ASSISTANT
// ═══════════════════════════════════════

const FILE_ROOTS = [
  "/storage/emulated/0",
  "/sdcard"
];

const MAX_FILE_RESULTS = 50;
const MAX_SEARCH_DEPTH = 12;

function normalizeFileQuery(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[“”"'`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function shellSafeFileName(text) {
  return String(text || "")
    .replace(/[^a-zA-Z0-9._ -]/g, "")
    .trim();
}

async function searchFiles(fileQuery, options = {}) {

  const queryText = normalizeFileQuery(fileQuery);

  if (!queryText) {
    return [];
  }

  const safeQuery = shellSafeFileName(queryText);

  if (!safeQuery) {
    return [];
  }

  const typeFilter = options.type || "";

  const root = "/storage/emulated/0";

  let command;

  if (typeFilter) {
    const safeType = shellSafeFileName(typeFilter)
      .replace(/^\./, "")
      .toLowerCase();

    command =
      `find ${quote(root)} ` +
      `-maxdepth ${MAX_SEARCH_DEPTH} ` +
      `-type f ` +
      `-iname ${quote("*" + safeQuery + "*")} ` +
      `-iname ${quote("*." + safeType)} ` +
      `-print 2>/dev/null | head -${MAX_FILE_RESULTS}`;
  } else {
    command =
      `find ${quote(root)} ` +
      `-maxdepth ${MAX_SEARCH_DEPTH} ` +
      `-type f ` +
      `-iname ${quote("*" + safeQuery + "*")} ` +
      `-print 2>/dev/null | head -${MAX_FILE_RESULTS}`;
  }

  const result = await run(command, 15000);

  if (!result.ok) {
    console.log(
      `[JARVIS FILE] Search failed: ${result.error || result.stderr || ""}`
    );

    return [];
  }

  return String(result.stdout || "")
    .split("\n")
    .map(x => x.trim())
    .filter(Boolean);
}

async function searchAllFilesByExtension(extension) {

  const safeExtension =
    shellSafeFileName(extension)
      .replace(/^\./, "")
      .toLowerCase();

  if (!safeExtension) {
    return [];
  }

  const command =
    `find ${quote("/storage/emulated/0")} ` +
    `-maxdepth ${MAX_SEARCH_DEPTH} ` +
    `-type f ` +
    `-iname ${quote("*." + safeExtension)} ` +
    `-print 2>/dev/null | head -${MAX_FILE_RESULTS}`;

  const result = await run(command, 15000);

  if (!result.ok) {
    return [];
  }

  return String(result.stdout || "")
    .split("\n")
    .map(x => x.trim())
    .filter(Boolean);
}

async function findFileOrFolder(name) {

  const safeName = shellSafeFileName(name);

  if (!safeName) {
    return [];
  }

  const command =
    `find ${quote("/storage/emulated/0")} ` +
    `-maxdepth ${MAX_SEARCH_DEPTH} ` +
    `\\( -type f -o -type d \\) ` +
    `-iname ${quote("*" + safeName + "*")} ` +
    `-print 2>/dev/null | head -${MAX_FILE_RESULTS}`;

  const result = await run(command, 15000);

  if (!result.ok) {
    return [];
  }

  return String(result.stdout || "")
    .split("\n")
    .map(x => x.trim())
    .filter(Boolean);
}

async function openLocalFile(filePath) {

  if (!filePath.startsWith("/storage/emulated/0/")) {
    return {
      ok: false,
      error: "For security, JARVIS can only open files in shared storage."
    };
  }

  const result = await run(
    `am start --user 0 ` +
    `-a android.intent.action.VIEW ` +
    `-d ${quote("file://" + filePath)}`
  );

  return {
    ok: result.ok,
    error:
      result.error ||
      result.stderr ||
      null
  };
}

async function openFileManager() {

  const attempts = [
    `am start --user 0 -a android.intent.action.VIEW -d ${quote("content://com.android.externalstorage.documents/root/primary")}`,
    `am start --user 0 -a android.intent.action.VIEW -d ${quote("content://com.android.externalstorage.documents/document/primary%3A")}`,
    `am start --user 0 -a android.intent.action.OPEN_DOCUMENT -c android.intent.category.OPENABLE`
  ];

  for (const command of attempts) {

    const result = await run(command, 10000);

    if (result.ok) {
      return {
        ok: true
      };
    }
  }

  return {
    ok: false,
    error: "Android did not provide a file manager."
  };
}

function formatFileResults(results) {

  if (!results.length) {
    return "I couldn't find any matching files in shared storage.";
  }

  if (results.length === 1) {
    return `I found it here: ${results[0]}`;
  }

  const shown = results.slice(0, 10);

  let text =
    `I found ${results.length} matching files. ` +
    `Here are the first ${shown.length}:\n`;

  shown.forEach((file, index) => {
    text += `${index + 1}. ${file}\n`;
  });

  if (results.length > shown.length) {
    text += `There are ${results.length - shown.length} more results.`;
  }

  return text.trim();
}

async function handleFileCommand(query, res) {

  const normalized = normalizeFileQuery(query);

  // Open File Manager
  if (
    /^(?:please\s+)?(?:open|launch|start|show)\s+(?:the\s+)?(?:file\s+manager|files|file\s+browser)$/i
      .test(normalized)
  ) {

    const result = await openFileManager();

    if (result.ok) {
      return reply(
        res,
        "Opening the file manager.",
        {
          mode: "offline",
          fileAction: "open_manager"
        }
      );
    }

    return reply(
      res,
      "I couldn't open the Android file manager.",
      {
        mode: "offline",
        fileAction: "open_manager",
        error: result.error
      }
    );
  }

  // Find / where is / locate
  const findMatch = normalized.match(
    /^(?:please\s+)?(?:find|search\s+for|locate|where\s+is|where's|show\s+me)\s+(?:the\s+)?(?:file\s+)?(.+?)\s*$/i
  );

  if (findMatch) {

    let name = findMatch[1]
      .trim()
      .replace(/\s+(?:file|document)$/i, "")
      .trim();

    // "find all pdfs"
    const extensionMatch = name.match(
      /^all\s+([a-z0-9]+)\s*(?:files?)?$/i
    );

    if (extensionMatch) {

      const extension = extensionMatch[1];

      const results =
        await searchAllFilesByExtension(extension);

      return reply(
        res,
        results.length
          ? formatFileResults(results)
          : `I couldn't find any .${extension} files in shared storage.`,
        {
          mode: "offline",
          fileAction: "search",
          query: name,
          count: results.length,
          results
        }
      );
    }

    // Remove common conversational words
    name = name
      .replace(/^my\s+/i, "")
      .replace(/^the\s+/i, "")
      .trim();

    const results =
      await findFileOrFolder(name);

    return reply(
      res,
      formatFileResults(results),
      {
        mode: "offline",
        fileAction: "search",
        query: name,
        count: results.length,
        results
      }
    );
  }

  // "find pdf files"
  const typeMatch = normalized.match(
    /^(?:please\s+)?(?:find|search)\s+(?:all\s+)?(.+?)\s+(?:files?|documents?)$/i
  );

  if (typeMatch) {

    const requestedType =
      typeMatch[1]
        .trim()
        .replace(/^\./, "");

    const results =
      await searchAllFilesByExtension(requestedType);

    return reply(
      res,
      results.length
        ? formatFileResults(results)
        : `I couldn't find any .${requestedType} files in shared storage.`,
      {
        mode: "offline",
        fileAction: "search",
        query: requestedType,
        count: results.length,
        results
      }
    );
  }

  // Open a specifically named file
  const openMatch = normalized.match(
    /^(?:please\s+)?open\s+(?:the\s+)?file\s+(.+)$/i
  );

  if (openMatch) {

    const name =
      openMatch[1]
        .trim();

    const results =
      await findFileOrFolder(name);

    const filesOnly =
      results.filter(x => !x.endsWith("/"));

    if (!filesOnly.length) {
      return reply(
        res,
        `I couldn't find a file named ${name}.`,
        {
          mode: "offline",
          fileAction: "open_file",
          query: name,
          count: 0
        }
      );
    }

    if (filesOnly.length > 1) {
      return reply(
        res,
        `I found multiple matches. The first one is:\n${filesOnly[0]}`,
        {
          mode: "offline",
          fileAction: "search",
          query: name,
          count: filesOnly.length,
          results: filesOnly.slice(0, 10)
        }
      );
    }

    const filePath = filesOnly[0];

    const result =
      await openLocalFile(filePath);

    if (result.ok) {
      return reply(
        res,
        `Opening ${filePath}.`,
        {
          mode: "offline",
          fileAction: "open_file",
          path: filePath
        }
      );
    }

    return reply(
      res,
      `I found ${filePath}, but Android could not open it.`,
      {
        mode: "offline",
        fileAction: "open_file",
        path: filePath,
        error: result.error
      }
    );
  }

  return null;
}

// ═══════════════════════════════════════
// COMMAND ENGINE
// ═══════════════════════════════════════

app.post("/api/command", async (req, res) => {

  const original = String(
    req.body.command || ""
  ).trim();

  if (!original) {
    return reply(
      res,
      "I didn't hear a command."
    );
  }

  const command = clean(original);

  const query = command
    .replace(
      /\b(jarvis|hey jarvis|okay jarvis|ok jarvis)\b/g,
      ""
    )
    .replace(/\s+/g, " ")
    .trim();

// ═══════════════════════════════════
// LOCAL FILE ASSISTANT HOOK
// ═══════════════════════════════════

const fileResponse =
  await handleFileCommand(query, res);

if (fileResponse !== null) {
  return fileResponse;
}


  // ═══════════════════════════════════
  // GREETINGS
  // ═══════════════════════════════════

  if (
    has(query, [
      "hello",
      "hi",
      "hey",
      "good morning",
      "good afternoon",
      "good evening"
    ])
  ) {
    return reply(
      res,
      "Good to hear from you. JARVIS is online and ready."
    );
  }

  // ═══════════════════════════════════
  // STATUS
  // ═══════════════════════════════════

  if (
    has(query, [
      "are you online",
      "are you there",
      "system status",
      "jarvis status",
      "status"
    ])
  ) {
    return reply(
      res,
      "All core JARVIS systems are online. I am operating in offline mode."
    );
  }

  // ═══════════════════════════════════
  // TIME
  // ═══════════════════════════════════

  if (
    has(query, [
      "what time is it",
      "what is the time",
      "what time it is",
      "tell me the time",
      "tell me what time it is",
      "current time",
      "time now",
      "what time is it now",
      "what is the current time",
      "current time now",
      "tell me current time",
      "tell me what the time is",
      "can you tell me the time",
      "do you know the time"
    ])
  ) {
    const now = new Date();

    const time = now.toLocaleTimeString(
      "en-IN",
      {
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit"
      }
    );

    return reply(
      res,
      `The current time is ${time}.`
    );
  }

  // ═══════════════════════════════════
  // DATE
  // ═══════════════════════════════════

  if (
    has(query, [
      "what is today's date",
      "what is the date",
      "what date is it",
      "what date is today",
      "today's date",
      "todays date",
      "current date",
      "today date",
      "date today",
      "tell me the date",
      "tell me today's date",
      "what day is it"
    ])
  ) {
    const now = new Date();

    const date = now.toLocaleDateString(
      "en-IN",
      {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric"
      }
    );

    return reply(
      res,
      `Today is ${date}.`
    );
  }

  // ═══════════════════════════════════
  // BATTERY
  // ═══════════════════════════════════

  if (
    has(query, [
      "battery",
      "battery level",
      "battery percentage",
      "battery percent",
      "battery status",
      "how much battery",
      "how much battery is left",
      "how much battery do i have",
      "what is my battery",
      "what is the battery",
      "check battery",
      "check my battery",
      "show battery",
      "tell me my battery",
      "tell me the battery level",
      "how much charge is left",
      "phone battery"
    ])
  ) {

    const result = await run(
      "termux-battery-status"
    );

    if (!result.output) {
      return reply(
        res,
        "I couldn't retrieve the battery status."
      );
    }

    try {
      const data = JSON.parse(
        result.output
      );

      const percentage =
        data.percentage ?? "unknown";

      const status =
        data.status ?? "unknown";

      const temperature =
        data.temperature;

      let text =
        `Battery level is ${percentage} percent. Status: ${status}.`;

      if (
        typeof temperature === "number"
      ) {
        text += ` Temperature is ${temperature} degrees Celsius.`;
      }

      return reply(res, text);

    } catch {
      return reply(
        res,
        "I received an invalid battery response."
      );
    }
  }

  // ═══════════════════════════════════
  // STORAGE
  // ═══════════════════════════════════

  if (
    has(query, [
      "storage",
      "storage space",
      "free space",
      "disk space",
      "how much storage",
      "how much storage is left",
      "how much free storage",
      "how much space is left",
      "check storage",
      "check my storage",
      "check storage space",
      "show storage",
      "tell me my storage",
      "tell me the storage",
      "phone storage",
      "internal storage"
    ])
  ) {

    const result = await run(
      "df -h /data 2>/dev/null | tail -1"
    );

    const parts =
      result.output.split(/\s+/);

    if (parts.length >= 5) {
      return reply(
        res,
        `Storage usage is ${parts[4]}, with ${parts[3]} available.`
      );
    }

    return reply(
      res,
      "I couldn't retrieve storage information."
    );
  }

  // ═══════════════════════════════════
  // DEVICE INFORMATION
  // ═══════════════════════════════════

  if (
    has(query, [
      "device information",
      "device info",
      "device details",
      "phone information",
      "phone info",
      "phone details",
      "system information",
      "system info",
      "my device information",
      "my device info",
      "my phone information",
      "my phone info",
      "tell me about my device",
      "tell me about my phone",
      "what device am i using",
      "what phone am i using",
      "show device information",
      "show device info"
    ])
  ) {

    const manufacturer =
      await run("getprop ro.product.manufacturer");

    const model =
      await run("getprop ro.product.model");

    const android =
      await run("getprop ro.build.version.release");

    const sdk =
      await run("getprop ro.build.version.sdk");

    return reply(
      res,
      `Device: ${manufacturer.output} ${model.output}. Android ${android.output}. SDK ${sdk.output}.`
    );
  }

  // ═══════════════════════════════════
  // NETWORK
  // ═══════════════════════════════════

  if (
    has(query, [
      "network",
      "network status",
      "network information",
      "network info",
      "internet status",
      "internet connection",
      "internet connection status",
      "connection status",
      "wifi status",
      "wi fi status",
      "wifi connection",
      "check network",
      "check my network",
      "check internet",
      "check my internet",
      "is internet working",
      "am i connected to the internet",
      "tell me my network status"
    ])
  ) {

    const wifi =
      await run(
        "dumpsys wifi 2>/dev/null | grep -m1 'Wi-Fi is'"
      );

    if (wifi.output) {
      return reply(
        res,
        wifi.output
      );
    }

    /*
     * Android/Termux may block access to the routing
     * netlink socket, so "ip route" is unreliable here.
     * Test actual Internet connectivity instead.
     */

    const internet =
      await run(
        "ping -c 1 -W 2 8.8.8.8 >/dev/null 2>&1"
      );

    if (internet.ok) {
      return reply(
        res,
        "Internet connection is active."
      );
    }

    const dns =
      await run(
        "ping -c 1 -W 2 google.com >/dev/null 2>&1"
      );

    if (dns.ok) {
      return reply(
        res,
        "Internet connection is active and DNS is working."
      );
    }

    return reply(
      res,
      "I couldn't confirm an active Internet connection."
    );
  }

  // ═══════════════════════════════════
  // VIBRATION
  // ═══════════════════════════════════

  if (
    has(query, [
      "vibrate",
      "vibration",
      "make the phone vibrate",
      "make phone vibrate",
      "vibrate my phone",
      "vibrate the phone",
      "phone vibration",
      "test vibration",
      "activate vibration",
      "turn on vibration"
    ])
  ) {

    const result =
      await run(
        "termux-vibrate -d 300"
      );

    return reply(
      res,
      result.ok
        ? "Vibration activated."
        : "I couldn't activate vibration."
    );
  }

  // ═══════════════════════════════════
  // BRIGHTNESS
  // ═══════════════════════════════════

  const brightness =
    query.match(
      /(?:set|change|make)?\s*(?:the\s+)?(?:screen\s+)?brightness(?:\s+to)?\s+(\d{1,3})(?:\s*percent)?/
    );

  if (brightness) {

    let level =
      Number(brightness[1]);

    level =
      Math.max(
        0,
        Math.min(100, level)
      );

    const result =
      await run(
        `termux-brightness ${level}`
      );

    return reply(
      res,
      result.ok
        ? `Brightness set to ${level} percent.`
        : "I couldn't change the brightness."
    );
  }

  // ═══════════════════════════════════
  // SCREENSHOT
  // ═══════════════════════════════════

  if (
    has(query, [
      "take screenshot",
      "take a screenshot",
      "capture screen",
      "capture screenshot",
      "screenshot",
      "take screen shot",
      "capture my screen",
      "take a picture of the screen",
      "capture the screen",
      "take a screen capture",
      "save screenshot"
    ])
  ) {

    const filename =
      `/sdcard/Pictures/JARVIS_${Date.now()}.png`;

    /*
     * Android exposes screencap on this device, but the
     * current Termux process is not permitted to capture
     * the display. Do not report a false successful capture.
     */

    const result =
      await run(
        `/system/bin/screencap -p ${quote(filename)}`
      );

    if (
      result.ok &&
      result.output === "" &&
      result.error === ""
    ) {
      return reply(
        res,
        `Screenshot saved to ${filename}.`
      );
    }

    return reply(
      res,
      "Screenshot capture isn't available from Termux on this device."
    );
  }

  // ═══════════════════════════════════

  if (
    has(query, [
      "take screenshot",
      "take a screenshot",
      "capture screen",
      "capture screenshot",
      "screenshot",
      "take screen shot",
      "capture my screen",
      "take a picture of the screen",
      "capture the screen",
      "take a screen capture",
      "save screenshot"
    ])
  ) {

    const filename =
      `/sdcard/Pictures/JARVIS_${Date.now()}.png`;

    /*
     * termux-screenshot is unavailable on this Termux setup.
     * Android's built-in screencap works instead.
     */
    const result =
      await run(
        `screencap -p ${quote(filename)}`
      );

    return reply(
      res,
      result.ok
        ? "Screenshot captured."
        : "I couldn't capture the screen."
    );
  }

  // ═══════════════════════════════════
  // GOOGLE SEARCH
  // ═══════════════════════════════════

  const search =
    query.match(
      /^(?:search google for|google search for|search for)\s+(.+)$/
    );

  if (search) {

    const text =
      encodeURIComponent(
        search[1]
      );

    const result =
      await openUrl(
        `https://www.google.com/search?q=${text}`
      );

    return reply(
      res,
      result.ok
        ? `Searching Google for ${search[1]}.`
        : "I couldn't open Google."
    );
  }

  // ═══════════════════════════════════
  // YOUTUBE
  // ═══════════════════════════════════

  if (
    has(query, [
      "open youtube",
      "launch youtube",
      "start youtube"
    ])
  ) {

    const result =
      await openUrl(
        "https://youtube.com"
      );

    return reply(
      res,
      result.ok
        ? "Opening YouTube."
        : "I couldn't open YouTube."
    );
  }

  // ═══════════════════════════════════
  // GOOGLE
  // ═══════════════════════════════════

  if (
    has(query, [
      "open google",
      "launch google",
      "start google"
    ])
  ) {

    const result =
      await openUrl(
        "https://google.com"
      );

    return reply(
      res,
      result.ok
        ? "Opening Google."
        : "I couldn't open Google."
    );
  }

  // ═══════════════════════════════════
  // URL
  // ═══════════════════════════════════

  const url =
    query.match(
      /^(?:open|launch|visit)\s+(https?:\/\/\S+)$/
    );

  if (url) {

    const result =
      await openUrl(url[1]);

    return reply(
      res,
      result.ok
        ? "Opening the requested website."
        : "I couldn't open that website."
    );
  }

  // ═══════════════════════════════════
  // TIMER
  // ═══════════════════════════════════

  const timer =
    query.match(
      /(?:set )?(?:a )?timer (?:for )?(\d+)\s*(seconds?|minutes?|hours?)/i
    );

  if (timer) {

    const amount =
      Number(timer[1]);

    const unit =
      timer[2].toLowerCase();

    let seconds =
      amount;

    if (
      unit.startsWith("minute")
    ) {
      seconds =
        amount * 60;
    }

    if (
      unit.startsWith("hour")
    ) {
      seconds =
        amount * 3600;
    }

    const id =
      createTimer(
        seconds,
        ""
      );

    return reply(
      res,
      `Timer ${id} set for ${amount} ${unit}.`
    );
  }

  // ═══════════════════════════════════
  // CANCEL TIMERS
  // ═══════════════════════════════════

  if (
    has(query, [
      "cancel timer",
      "cancel all timers",
      "stop timer",
      "stop all timers"
    ])
  ) {

    const count =
      timers.size;

    cancelAllTimers();

    return reply(
      res,
      count
        ? `Cancelled ${count} timer${count === 1 ? "" : "s"}.`
        : "There were no active timers."
    );
  }

  // ═══════════════════════════════════
  // KNOWN APP LAUNCHER
  // ═══════════════════════════════════

  if (
    /^(?:please )?(?:open|launch|start)\s+/.test(query)
  ) {

    let appName =
      query.replace(
        /^(?:please )?(?:open|launch|start)\s+/,
        ""
      ).trim();

    appName =
      appName
        .replace(/^my\s+/, "")
        .replace(/^the\s+/, "")
        .trim();

    const result =
      await launchKnownApp(
        appName
      );

    if (result.ok) {
      return reply(
        res,
        `Opening ${appName}.`,
        {
          app: appName,
          package: result.packageName
        }
      );
    }

    if (
      result.reason === "unknown"
    ) {
      return reply(
        res,
        `I don't have Android launcher access for ${appName} yet. The universal app launcher will be connected through the Android companion later.`
      );
    }

    return reply(
      res,
      `I found ${appName}, but Android did not allow JARVIS to launch it from Termux.`
    );
  }

  // ═══════════════════════════════════
  // HELP
  // ═══════════════════════════════════

  if (
    has(query, [
      "what can you do",
      "what can you control",
      "help",
      "commands"
    ])
  ) {

    return reply(
      res,
      "I can check battery, storage, device information and network status; control brightness and vibration; capture screenshots; open websites; search Google; create timers; and launch supported applications."
    );
  }

   // ═══════════════════════════════════
  // GEMINI AI FALLBACK
  // ═══════════════════════════════════

  try {
    console.log(`[JARVIS AI] User: ${original}`);

    const aiResponse = await askGemini(original);

    console.log(`[JARVIS AI] JARVIS: ${aiResponse}`);

    return reply(
      res,
      aiResponse,
      {
        mode: "gemini"
      }
    );

  } catch (error) {
    console.error(
      "[JARVIS AI] Error:",
      error.message
    );

    return reply(
      res,
      "My AI core is temporarily unavailable. My local command systems are still operational.",
      {
        mode: "offline"
      }
    );
  }
});

// ═══════════════════════════════════════
// VOICE COMMAND
// ═══════════════════════════════════════

app.post("/api/voice", async (req, res) => {

  console.log("[JARVIS VOICE] Listening...");

  const speech =
    await run(
      "termux-speech-to-text",
      30000
    );

  const command =
    String(speech.output || "")
      .replace(/\s+/g, " ")
      .trim();

  console.log(
    `[JARVIS VOICE] Heard: ${command || "(nothing)"}`
  );

  if (!command) {
    return reply(
      res,
      "I didn't hear anything."
    );
  }

  try {

    const response =
      await fetch(
        `http://127.0.0.1:${PORT}/api/command`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            command
          })
        }
      );

    const data =
      await response.json();

    const text =
      data.reply ||
      "Command completed.";

    console.log(
      `[JARVIS VOICE] Reply: ${text}`
    );

    /*
     * Start TTS without making the HTTP request wait
     * for the entire speech to finish.
     */
    speak(text).catch(error => {
      console.error(
        "[JARVIS TTS] Error:",
        error.message
      );
    });

    return res.json({
      ok: true,
      command,
      reply: text,
      mode: data.mode || "unknown"
    });

  } catch (error) {

    console.error(
      "[JARVIS VOICE] Error:",
      error.message
    );

    return reply(
      res,
      `I heard "${command}", but I couldn't process it.`
    );
  }
});

// ═══════════════════════════════════════
// TIMER API
// ═══════════════════════════════════════

app.get("/api/timers", (req, res) => {

  const active =
    [...timers.values()].map(timer => ({
      id: timer.id,
      label: timer.label,
      seconds: timer.seconds,
      remaining: Math.max(
        0,
        Math.ceil(
          (
            timer.created +
            timer.seconds * 1000 -
            Date.now()
          ) / 1000
        )
      )
    }));

  res.json({
    ok: true,
    timers: active
  });
});

// ═══════════════════════════════════════
// JARVIS STATUS
// ═══════════════════════════════════════

app.get("/api/status", (req, res) => {

  res.json({
    online: true,
    name: "JARVIS",
    mode: "offline",
    api: false,
    voice: true,
    timers: timers.size,
    timestamp: new Date().toISOString()
  });
});

// ═══════════════════════════════════════
// START
// ═══════════════════════════════════════

app.listen(
  PORT,
  "127.0.0.1",
  () => {
    console.log(
      `JARVIS ONLINE → http://127.0.0.1:${PORT}`
    );
  }
);
