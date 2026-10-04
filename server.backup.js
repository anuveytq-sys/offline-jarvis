import express from "express";
import { exec } from "child_process";

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static("public"));

function run(command) {
  return new Promise((resolve) => {
    exec(command, { timeout: 8000 }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        output: (stdout || "").trim(),
        error: (stderr || error?.message || "").trim()
      });
    });
  });
}

function send(res, reply) {
  res.json({ reply });
}

function hasAny(text, words) {
  return words.some(word => text.includes(word));
}

function clean(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

app.post("/api/command", async (req, res) => {
  const original = String(req.body.command || "").trim();
  const command = clean(original);

  if (!command) {
    return send(res, "I didn't hear a command.");
  }

  // Remove common wake/name words
  const query = command
    .replace(/\b(jarvis|hey jarvis|okay jarvis|ok jarvis)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();

  // ─────────────────────────────
  // GREETING
  // ─────────────────────────────
  if (hasAny(query, ["hello", "hi", "hey", "good morning", "good evening"])) {
    return send(
      res,
      "Hello. JARVIS offline core is online and ready."
    );
  }

  // ─────────────────────────────
  // TIME
  // ─────────────────────────────
  if (
    hasAny(query, ["what time", "current time", "time now", "tell me the time"]) ||
    query === "time"
  ) {
    return send(
      res,
      `The current time is ${new Date().toLocaleTimeString()}.`
    );
  }

  // ─────────────────────────────
  // DATE
  // ─────────────────────────────
  if (
    hasAny(query, ["what date", "today date", "todays date", "date today"]) ||
    query === "date" ||
    query === "today"
  ) {
    return send(
      res,
      `Today is ${new Date().toLocaleDateString()}.`
    );
  }

  // ─────────────────────────────
  // BATTERY
  // ─────────────────────────────
  if (
    hasAny(query, [
      "battery",
      "battery level",
      "battery percentage",
      "how much battery",
      "charge level",
      "charge percentage",
      "power level"
    ])
  ) {
    const result = await run("termux-battery-status");

    try {
      const data = JSON.parse(result.output);

      let message = `Your battery is at ${data.percentage} percent.`;

      if (data.status) {
        message += ` Status: ${data.status}.`;
      }

      if (data.plugged && data.plugged !== "UNPLUGGED") {
        message += ` Power source: ${data.plugged}.`;
      }

      return send(res, message);
    } catch {
      return send(res, "I couldn't read the battery information.");
    }
  }

  // ─────────────────────────────
  // STORAGE
  // ─────────────────────────────
  if (
    hasAny(query, [
      "storage",
      "disk space",
      "free space",
      "available space",
      "phone space",
      "memory space"
    ])
  ) {
    const result = await run("df -h /data");
    const lines = result.output.split("\n");

    if (lines.length >= 2) {
      const parts = lines[1].split(/\s+/);

      return send(
        res,
        `You have ${parts[3] || "unknown"} available out of ` +
        `${parts[1] || "unknown"}. Storage usage is ` +
        `${parts[4] || "unknown"}.`
      );
    }

    return send(res, "I couldn't read the storage information.");
  }

  // ─────────────────────────────
  // DEVICE INFORMATION
  // ─────────────────────────────
  if (
    hasAny(query, [
      "device information",
      "device info",
      "system information",
      "system info",
      "phone information",
      "phone info",
      "what phone",
      "which phone",
      "android version"
    ])
  ) {
    const model = await run("getprop ro.product.model");
    const android = await run("getprop ro.build.version.release");

    return send(
      res,
      `Your device is ${model.output || "unknown"}. ` +
      `You are running Android ${android.output || "unknown"}.`
    );
  }

  // ─────────────────────────────
  // FLASHLIGHT
  // ─────────────────────────────
  const flashlight =
    hasAny(query, [
      "flashlight",
      "flash light",
      "torch",
      "phone light"
    ]);

  const turnOn =
    hasAny(query, [
      "turn on",
      "switch on",
      "switch the light on",
      "activate",
      "enable",
      "start",
      "on"
    ]);

  const turnOff =
    hasAny(query, [
      "turn off",
      "switch off",
      "switch the light off",
      "deactivate",
      "disable",
      "stop",
      "off"
    ]);

  if (flashlight && turnOn && !turnOff) {
    const result = await run("termux-torch on");

    if (result.ok) {
      return send(res, "Flashlight activated.");
    }

    return send(
      res,
      "I understood the flashlight command, but Android did not allow me to control the flashlight."
    );
  }

  if (flashlight && turnOff && !turnOn) {
    const result = await run("termux-torch off");

    if (result.ok) {
      return send(res, "Flashlight deactivated.");
    }

    return send(
      res,
      "I understood the flashlight command, but Android did not allow me to control the flashlight."
    );
  }

  // If user only says "flashlight"
  if (flashlight) {
    return send(
      res,
      "I detected a flashlight request. Say turn on or turn off."
    );
  }

  // ─────────────────────────────
  // VIBRATION
  // ─────────────────────────────
  if (
    hasAny(query, [
      "vibrate",
      "vibration",
      "make phone vibrate",
      "vibrate phone"
    ])
  ) {
    const result = await run("termux-vibrate -d 500");

    if (result.ok) {
      return send(res, "Vibration activated.");
    }

    return send(res, "I couldn't activate vibration.");
  }

  // ─────────────────────────────
  // BRIGHTNESS
  // ─────────────────────────────
  if (query.includes("brightness")) {
    const number = query.match(/\b(\d{1,3})\b/);

    if (!number) {
      return send(
        res,
        "Tell me the brightness level, for example: set brightness to 100."
      );
    }

    let level = Number(number[1]);
    level = Math.max(0, Math.min(255, level));

    const result = await run(`termux-brightness ${level}`);

    if (result.ok) {
      return send(res, `Brightness set to ${level}.`);
    }

    return send(res, "I couldn't change the brightness.");
  }

  // ─────────────────────────────
  // VOLUME
  // ─────────────────────────────
  if (query.includes("volume")) {
    const number = query.match(/\b(\d{1,2})\b/);

    if (!number) {
      return send(
        res,
        "Tell me the volume level from 0 to 15."
      );
    }

    let level = Number(number[1]);
    level = Math.max(0, Math.min(15, level));

    const result = await run(`termux-volume music ${level}`);

    if (result.ok) {
      return send(res, `Media volume set to ${level}.`);
    }

    return send(res, "I couldn't change the volume.");
  }

  // ─────────────────────────────
  // SCREENSHOT
  // ─────────────────────────────
  if (
    hasAny(query, [
      "screenshot",
      "screen shot",
      "capture screen",
      "take a picture of the screen",
      "capture my screen"
    ])
  ) {
    const file = `/sdcard/Pictures/JARVIS-${Date.now()}.png`;

    const result = await run(
      `termux-screenshot "${file}"`
    );

    if (result.ok) {
      return send(res, "Screenshot captured.");
    }

    return send(res, "I couldn't capture the screen.");
  }

  // ─────────────────────────────
  // YOUTUBE
  // ─────────────────────────────
  if (
    hasAny(query, [
      "open youtube",
      "launch youtube",
      "start youtube",
      "youtube"
    ])
  ) {
    await run(
      "am start -a android.intent.action.VIEW -d https://youtube.com"
    );

    return send(res, "Opening YouTube.");
  }

  // ─────────────────────────────
  // GOOGLE
  // ─────────────────────────────
  if (
    hasAny(query, [
      "open google",
      "launch google",
      "start google",
      "google"
    ])
  ) {
    await run(
      "am start -a android.intent.action.VIEW -d https://google.com"
    );

    return send(res, "Opening Google.");
  }

  // ─────────────────────────────
  // TIMER
  // ─────────────────────────────
  if (
    hasAny(query, [
      "timer",
      "countdown",
      "alarm"
    ])
  ) {
    const match = query.match(
      /(\d+)\s*(second|seconds|minute|minutes|hour|hours)/
    );

    if (!match) {
      return send(
        res,
        "Tell me the duration, for example: set a timer for 10 minutes."
      );
    }

    const amount = Number(match[1]);
    const unit = match[2];

    let seconds = amount;

    if (unit.startsWith("minute")) {
      seconds = amount * 60;
    }

    if (unit.startsWith("hour")) {
      seconds = amount * 3600;
    }

    setTimeout(async () => {
      await run(
        "termux-notification " +
        "--title 'JARVIS' " +
        "--content 'Timer complete.'"
      );
    }, seconds * 1000);

    return send(
      res,
      `Timer set for ${amount} ${unit}.`
    );
  }

  // ─────────────────────────────
  // UNKNOWN REQUEST
  // ─────────────────────────────
  return send(
    res,
    `I understood your request as: "${original}". ` +
    `That capability isn't installed yet. ` +
    `I currently support flashlight, battery, storage, ` +
    `device information, time, date, brightness, volume, ` +
    `vibration, screenshots, timers, Google and YouTube.`
  );
});



// ─────────────────────────────
// VOICE COMMAND
// ─────────────────────────────
function shellQuote(text) {
  return "'" + String(text).replace(/'/g, "'\\''") + "'";
}

app.post("/api/voice", async (req, res) => {
  const speech = await run("termux-speech-to-text");
  const command = speech.output.trim();

  if (!command) {
    return send(res, "I didn't hear anything.");
  }

  // Send the recognized speech through the SAME
  // command engine used by normal text commands.
  try {
    const response = await fetch(
      `http://127.0.0.1:${PORT}/api/command`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ command })
      }
    );

    const data = await response.json();
    const reply = data.reply || "Command completed.";

    // Speak JARVIS's response through Android TTS.
    await run(
      `termux-tts-speak ${shellQuote(reply)}`
    );

    return res.json({
      command,
      reply
    });

  } catch (error) {
    return send(
      res,
      `I heard "${command}", but I couldn't process the request.`
    );
  }
});


app.listen(PORT, "127.0.0.1", () => {
  console.log(`JARVIS ONLINE → http://127.0.0.1:${PORT}`);
});
