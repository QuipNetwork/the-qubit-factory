/*
 * Qubit Factory Link — open a generated circuit from the URL in the sandbox.
 *
 * Reads `#seed=<hex>` or `#qasm=<base64url QASM>` from the page URL, builds the
 * corresponding circuit on the factory board, and drops the player into it so
 * they can press play and watch it run. Optional `&pattern=&palette=&sig=&rares=`
 * params enrich the side panel with NFT-trait info from quantum-echoes.
 *
 * The circuit is constrained to what the engine can represent exactly: a
 * real-amplitude ("rebit") model, 6 qubit channels, and the gate set
 * H, X, Z, RY, CX, CZ, SWAP. The #seed generator mirrors quantum-echoes'
 * src/lib/quantum/circuit.ts byte-for-byte so a seed yields the same circuit in
 * both places.
 *
 * Loaded as a classic <script> after scripts.min.js, so the engine globals
 * (IBOARD, Board, Qubit, Gate, FIELD, SCENARIO, InitScenario, LevelRefresh,
 * STATE, TIMER, SFX) resolve as bare identifiers via the shared global scope.
 */
(function () {
  "use strict";

  // ---- Circuit generator (mirror of quantum-echoes/src/lib/quantum/circuit.ts) ----
  var QF_QUBITS = 6;
  var QF_MOMENTS = 16;
  var SINGLE_GATES = ["H", "X", "Z", "RY"];
  var TWO_QUBIT_GATES = [
    { label: "CX", type: "cx" },
    { label: "CZ", type: "cz" },
    { label: "SW", type: "swap" },
  ];

  function generateCircuit(seedHex, qubits, moments) {
    qubits = qubits || QF_QUBITS;
    moments = moments || QF_MOMENTS;
    var s = parseInt(seedHex.slice(0, 8), 16) >>> 0;
    if (s === 0) s = 1;
    var rand = function () {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 0x100000000;
    };
    var randInt = function (n) { return Math.floor(rand() * n); };

    var gates = [];
    for (var m = 0; m < moments; m++) {
      var occupied = {};
      var size = 0;
      var targetFill = Math.floor(qubits * (0.45 + rand() * 0.35));
      var attempts = 0;
      while (size < targetFill && attempts < qubits * 3) {
        attempts++;
        var tryTwo = rand() < 0.32 && size <= qubits - 2;
        if (tryTwo) {
          var q1 = randInt(qubits - 1);
          var q2 = q1 + 1;
          if (occupied[q1] || occupied[q2]) continue;
          var choice = TWO_QUBIT_GATES[randInt(TWO_QUBIT_GATES.length)];
          gates.push({ moment: m, qubits: [q1, q2], label: choice.label, type: choice.type });
          occupied[q1] = occupied[q2] = true;
          size += 2;
        } else {
          var q = randInt(qubits);
          if (occupied[q]) continue;
          var label = SINGLE_GATES[randInt(SINGLE_GATES.length)];
          gates.push({ moment: m, qubits: [q], label: label, type: "single" });
          occupied[q] = true;
          size += 1;
        }
      }
    }
    return gates;
  }

  // ---- Gate -> engine encoding (real-amplitude model) ----
  // single-qubit: returns { type, rot, tile }
  var PI = Math.PI;
  function singleEnc(label) {
    switch (label) {
      case "H": return { type: "qFlip", rot: PI / 4, tile: 68 };
      case "X": return { type: "qFlip", rot: PI / 2, tile: 68 };
      case "Z": return { type: "qFlip", rot: 0, tile: 68 };
      case "RY": return { type: "rotate", rot: PI / 2, tile: 62 }; // art "RY" has no angle; standardize to pi/2
      default: return { type: "qFlip", rot: 0, tile: 68 };
    }
  }

  var ROW0 = 4;            // top wire row
  var PLAIN = 2;           // plain transport tile
  var QCTRL_TILE = 62;     // quantum tile under a qControl
  var SOURCE_DIR_IN = 0;   // entered from left
  var DIR_RIGHT = 2;       // moving right

  // Build the board model { tiles, qubits, gates, truncated } for the circuit.
  function buildBoardModel(circuit, nQubits) {
    var C = FIELD.cols, R = FIELD.rows;
    var maxCol = C - 2;                       // last usable gate column
    var rowOf = function (q) { return ROW0 + q; };
    var tiles = new Array(C * R).fill(-1);
    for (var q = 0; q < nQubits; q++) {
      var row = rowOf(q);
      for (var c = 0; c < C; c++) tiles[row * C + c] = PLAIN;
    }
    var gateTuples = [];
    var qubitTuples = [];
    for (var q2 = 0; q2 < nQubits; q2++) {
      qubitTuples.push([0, rowOf(q2), SOURCE_DIR_IN, DIR_RIGHT, "move", 0, false]);
    }
    var cursor = new Array(nQubits).fill(0);   // last column used per qubit
    var truncated = false;
    var nSingle = 0, nTwo = 0, lastCol = 0;    // stats for the info panel

    var placeSingle = function (col, q, label, angle) {
      var enc = singleEnc(label);
      var rot = (typeof angle === "number") ? angle : enc.rot; // QASM ry(theta) override
      tiles[rowOf(q) * C + col] = enc.tile;
      gateTuples.push([col, rowOf(q), enc.type, "free", 0, rot, 0, 0, -1]);
    };
    // control = upper qubit, target = lower (target = control+1). orientCtrl 0=down.
    var placeControlled = function (col, ctrlQ, tgtQ, tgtType, tgtRot) {
      var orient = (tgtQ > ctrlQ) ? 0 /*down*/ : 2 /*up*/;
      tiles[rowOf(ctrlQ) * C + col] = QCTRL_TILE;
      gateTuples.push([col, rowOf(ctrlQ), "qControl", "free", orient, 0, 0, 0, -1]);
      tiles[rowOf(tgtQ) * C + col] = (tgtType === "rotate") ? 62 : 68;
      gateTuples.push([col, rowOf(tgtQ), tgtType, "free", 0, tgtRot, 0, 0, -1]);
    };
    var nextCol = function (qs) {
      var m = 0;
      for (var i = 0; i < qs.length; i++) m = Math.max(m, cursor[qs[i]]);
      return m + 1;
    };

    // Gates are emitted moment-major, so stopping at the first gate that does
    // not fit yields a clean temporal PREFIX of the circuit (exact as far as it
    // goes) rather than a scattered subset.
    for (var gi = 0; gi < circuit.length; gi++) {
      var g = circuit[gi];
      if (g.type === "single") {
        var col = nextCol([g.qubits[0]]);
        if (col > maxCol) { truncated = true; break; }
        placeSingle(col, g.qubits[0], g.label, g.angle);
        cursor[g.qubits[0]] = col;
        nSingle++; lastCol = Math.max(lastCol, col);
      } else if (g.type === "cx" || g.type === "cz") {
        var c1 = g.qubits[0], t1 = g.qubits[1];
        if (Math.abs(c1 - t1) !== 1) { truncated = true; continue; } // QF needs adjacency
        var colc = nextCol([c1, t1]);
        if (colc > maxCol) { truncated = true; break; }
        if (g.type === "cx") placeControlled(colc, c1, t1, "qFlip", PI / 2);
        else placeControlled(colc, c1, t1, "qFlip", 0); // CZ
        cursor[c1] = cursor[t1] = colc;
        nTwo++; lastCol = Math.max(lastCol, colc);
      } else if (g.type === "swap") {
        // SWAP = CX(a,b) CX(b,a) CX(a,b), three columns.
        var a = g.qubits[0], b = g.qubits[1];
        if (Math.abs(a - b) !== 1) { truncated = true; continue; }
        var col0 = nextCol([a, b]);
        if (col0 + 2 > maxCol) { truncated = true; break; }
        placeControlled(col0, a, b, "qFlip", PI / 2);
        placeControlled(col0 + 1, b, a, "qFlip", PI / 2);
        placeControlled(col0 + 2, a, b, "qFlip", PI / 2);
        cursor[a] = cursor[b] = col0 + 2;
        nTwo++; lastCol = Math.max(lastCol, col0 + 2);
      }
    }
    return {
      tiles: tiles, qubits: qubitTuples, gates: gateTuples, truncated: truncated,
      stats: { qubits: nQubits, single: nSingle, two: nTwo, depth: lastCol },
    };
  }

  // Install the model into the live construction board.
  function installCircuit(model) {
    SCENARIO.whichOne = "freeA";
    InitScenario.load("freeA", false);
    LevelRefresh(SCENARIO.name, IBOARD);
    // Clear the freeA design template (it injects a qCreate at [17,0]).
    IBOARD._gateList = [];
    IBOARD._qubitList = [];
    IBOARD._bitList = [];
    IBOARD._tiles = model.tiles;
    IBOARD.setAllBits([], JSON.parse(JSON.stringify(model.qubits)), []);
    IBOARD.setAllGates(JSON.parse(JSON.stringify(model.gates)));
    LevelRefresh(SCENARIO.name, IBOARD);
    if (typeof UNDOREDO !== "undefined" && UNDOREDO.reset) UNDOREDO.reset();
    STATE.mode = "constructing";
  }

  // ---- URL parsing ----
  function readParam(name) {
    var hash = location.hash.replace(/^#/, "");
    var src = hash || location.search.replace(/^\?/, "");
    var parts = src.split("&");
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].split("=");
      if (kv[0] === name) return decodeURIComponent(kv[1] || "");
    }
    return null;
  }
  function normalizeSeed(raw) {
    var hex = (raw || "").toLowerCase().replace(/[^0-9a-f]/g, "");
    if (!hex) return null;
    while (hex.length < 8) hex += hex;          // ensure >= 8 hex chars for the LCG
    return hex.slice(0, 64);
  }

  // ---- OpenQASM (subset) parsing ----
  function b64urlDecode(s) {
    s = s.replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    return decodeURIComponent(escape(atob(s)));
  }
  function evalAngle(s) {
    if (!s) return undefined;
    s = s.replace(/pi/gi, String(Math.PI));
    if (!/^[-+*/().0-9eE\s]+$/.test(s)) return undefined; // arithmetic only
    try { return Function("return (" + s + ")")(); } catch (e) { return undefined; }
  }
  function parseQasm(text) {
    var gates = [], nQ = QF_QUBITS, m;
    var stmts = text.split(/;|\n/);
    for (var i = 0; i < stmts.length; i++) {
      var ln = stmts[i].trim().toLowerCase();
      if (!ln || ln.indexOf("openqasm") === 0 || ln.indexOf("include") === 0 ||
          ln.indexOf("creg") === 0 || ln.indexOf("measure") === 0 ||
          ln.indexOf("barrier") === 0 || ln.indexOf("//") === 0) continue;
      if ((m = ln.match(/qreg\s+\w+\[(\d+)\]/))) { nQ = parseInt(m[1], 10); continue; }
      if ((m = ln.match(/^(cx|cz|swap)\s+\w+\[(\d+)\]\s*,\s*\w+\[(\d+)\]/))) {
        gates.push({ type: m[1] === "swap" ? "swap" : m[1], qubits: [parseInt(m[2], 10), parseInt(m[3], 10)] });
        continue;
      }
      if ((m = ln.match(/^(h|x|z|ry)\s*(\(([^)]*)\))?\s+\w+\[(\d+)\]/))) {
        var name = m[1].toUpperCase();
        gates.push({ type: "single", label: name, qubits: [parseInt(m[4], 10)],
                     angle: name === "RY" ? evalAngle(m[3]) : undefined });
        continue;
      }
      // y/s/t/rx and anything else: unsupported in the real-amplitude model; skip.
    }
    return { gates: gates, nQubits: Math.max(1, Math.min(QF_QUBITS, nQ)) };
  }

  function circuitFromUrl() {
    var seed = readParam("seed");
    if (seed) {
      var hex = normalizeSeed(seed);
      if (!hex) return null;
      return { mode: "seed", seedHex: hex, gates: generateCircuit(hex, QF_QUBITS, QF_MOMENTS), nQubits: QF_QUBITS };
    }
    var qasm = readParam("qasm");
    if (qasm) {
      var text;
      try { text = b64urlDecode(qasm); } catch (e) { text = decodeURIComponent(qasm); }
      var parsed = parseQasm(text);
      if (!parsed.gates.length) return null;
      return { mode: "qasm", seedHex: null, gates: parsed.gates, nQubits: parsed.nQubits };
    }
    return null;
  }

  function message(msg) {
    try {
      FIELD.message = msg;
      TIMER.message = TIMER.messageMax;
    } catch (e) { /* board not ready */ }
  }

  // Replace the sandbox info panel with details about this circuit/seed.
  function setPanel(spec, model) {
    var info = [];
    if (spec.mode === "seed") info.push("• Seed: " + spec.seedHex.slice(0, 10) + "…" + spec.seedHex.slice(-6));
    else info.push("• Source: OpenQASM");
    var pat = readParam("pattern"), pal = readParam("palette"),
        sig = readParam("sig"), rares = readParam("rares");
    if (pat) info.push("• Pattern: " + pat);
    if (pal) info.push("• Palette: " + pal);
    if (sig) info.push("• Signature: #" + sig.replace(/^#/, ""));
    if (rares) info.push("• Rares: " + rares);
    var st = model.stats;
    info.push("• " + st.qubits + " qubits · " + (st.single + st.two) + " gates · " + st.two + " entangling");
    if (model.truncated) info.push("• Trimmed to fit the factory grid");
    try {
      SCENARIO.title = spec.mode === "seed" ? "Quantum Echo" : "QASM Circuit";
      SCENARIO.info = info;
    } catch (e) { /* panel not ready */ }
  }

  function tryLoad() {
    var spec = circuitFromUrl();
    if (!spec) return;
    try {
      var model = buildBoardModel(spec.gates, spec.nQubits);
      installCircuit(model);
      setPanel(spec, model);
      message(model.truncated ? "Circuit loaded (trimmed to fit). Press play!" : "Circuit loaded! Press play.");
      if (typeof SFX !== "undefined" && SFX.click2) SFX.click2.play();
    } catch (e) {
      message("Could not load circuit from link.");
      if (window.console) console.error("[qubit-factory-link]", e);
    }
  }

  // Wait until the engine has booted, then load.
  function ready() {
    return typeof IBOARD !== "undefined" && typeof InitScenario !== "undefined"
      && typeof FIELD !== "undefined" && FIELD.cols && typeof LevelRefresh !== "undefined";
  }
  if (!location.hash && !location.search) return; // nothing to do
  var tries = 0;
  var timer = setInterval(function () {
    tries++;
    if (ready()) { clearInterval(timer); setTimeout(tryLoad, 600); }
    else if (tries > 200) clearInterval(timer);
  }, 100);
})();
