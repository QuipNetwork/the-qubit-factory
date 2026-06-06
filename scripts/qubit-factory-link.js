/*
 * Qubit Factory Link — open a generated circuit from the URL.
 *
 * Reads `#seed=<hex>` or `#qasm=<base64url QASM>` from the page URL and builds a
 * single playable level on the factory board:
 *   - Rows 5 and 8 are the scored channels: A=|0> -> C and B=|1> -> D, collected
 *     by qCompare; pass them through unchanged (the straight wire already solves
 *     it) to win.
 *   - Every other visible row carries the seed's generated circuit: a qCreate
 *     feeder -> the seed's gates -> a trash collector. These run alongside the
 *     scored channels (filler), filling the board.
 *
 * There are no mode/score URL params — the behavior and goal are fixed defaults.
 * Optional `&pattern=&palette=&sig=&rares=` enrich the side panel with NFT-trait
 * info from quantum-echoes.
 *
 * The circuit is constrained to what the engine represents exactly: a real-
 * amplitude ("rebit") model and the gate set H, X, Z, RY, CX, CZ, SWAP. The
 * #seed generator mirrors quantum-echoes' src/lib/quantum/circuit.ts so a seed
 * yields the same construction here.
 *
 * Loaded as a classic <script> after scripts.min.js, so the engine globals
 * (IBOARD, FIELD, SCENARIO, InitScenario, LevelGates, LevelRefresh, Overlay,
 * Menu, MENU, CANV, PERSIST0, BoardData, STATE, TIMER, UNDOREDO, SFX) resolve as
 * bare identifiers via the shared global scope.
 */
(function () {
  "use strict";

  // ---- Circuit generator (mirror of quantum-echoes/src/lib/quantum/circuit.ts) ----
  var SINGLE_GATES = ["H", "X", "Z", "RY"];
  var TWO_QUBIT_GATES = [
    { label: "CX", type: "cx" },
    { label: "CZ", type: "cz" },
    { label: "SW", type: "swap" },
  ];

  function generateCircuit(seedHex, qubits, moments) {
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
  var PI = Math.PI;
  function singleEnc(label) {
    switch (label) {
      case "H": return { type: "qFlip", rot: PI / 4, tile: 68 };
      case "X": return { type: "qFlip", rot: PI / 2, tile: 68 };
      case "Z": return { type: "qFlip", rot: 0, tile: 68 };
      case "RY": return { type: "rotate", rot: PI / 2, tile: 62 };
      default: return { type: "qFlip", rot: 0, tile: 68 };
    }
  }

  // ---- Board layout (we know the exact geometry: 19 cols x 14 rows) ----
  var PLAIN = 2;            // plain transport tile
  var QCTRL_TILE = 62;      // quantum tile (qControl seat / quantum lane)
  var GOAL = 20;            // correct outputs to win (fixed)
  var GEN_MOMENTS = 16;     // generated circuit depth (placement caps it to the cols)
  // Camera focus that yields cameraX=cameraY=0 (board centered in the play frame).
  var CAM_FX = 6.5, CAM_FY = 2.5;
  // The seed circuit fills every visible interior row (1-12). Rows 5,8 are the
  // scored A/B -> C/D channels: the circuit's single-qubit gates land on them too,
  // so the output is wrong until the player fixes the circuit (that's the game).
  // Two-qubit interactions are kept off the scored rows so they stay fixable.
  // Rows 0,13 remain quant1's queue-feeder corners.
  var CIRCUIT_ROWS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  var isScored = function (row) { return row === 5 || row === 8; };

  // Build the unified level into the live board.
  function loadLevel(spec) {
    SCENARIO.whichOne = "quant1";
    InitScenario.load("quant1", false);          // scored device base
    // Pristine quant1 def — immune to the player's saved blueprint in localStorage.
    var def = LevelGates("quant1", false);
    var C = FIELD.cols;

    // Scored streams: A = |0> (queue index 0 = angle 0), B = |1> (index 8 = pi).
    var N = 100;
    SCENARIO.QINPUTS[0] = new Array(N).fill(0);
    SCENARIO.QINPUTS[1] = new Array(N).fill(8);
    SCENARIO.maxTrials = GOAL; SCENARIO.numCorrect = GOAL;
    try { SCENARIO.editable = BoardData.makeEditable(true, [-1, -1, -1, -1, 0, 0], 0); } catch (e) {}

    // Start from the pristine tiles (keeps the A/B/C/D port tiles + corner queue
    // tiles), then lay every circuit row as a clean wire.
    var tiles = def.tiles.slice();
    // Keep only the scored machinery: corner qCreate queue feeders + the C/D
    // qCompare collectors. Drop quant1's pre-placed inversion gates.
    var gates = def.allGates
      .map(function (g) { return Array.isArray(g) ? g.slice() : g.pack(); })
      .filter(function (p) { return p[2] === "qCompare" || p[2] === "qCreate"; });

    var FEED_COL = 0, OUT_COL = C - 1, LAST_GATE_COL = C - 2; // gates in cols 1..17
    var rows = CIRCUIT_ROWS;
    var n = Math.min(spec.nQubits, rows.length);
    var rowOf = function (q) { return rows[q]; };

    // Wire each line end to end. Scored rows (5,8) keep their A/B input port and
    // C/D qCompare collector; every other line gets a continuous qCreate feeder
    // (random qubit) and a trash collector so it runs without jamming.
    for (var ri = 0; ri < n; ri++) {
      var row = rows[ri];
      for (var c = 1; c <= C - 2; c++) tiles[row * C + c] = PLAIN; // wire interior
      if (!isScored(row)) {
        tiles[row * C + FEED_COL] = QCTRL_TILE;
        gates.push([FEED_COL, row, "qCreate", "free", 0, 2, 0, 0, -1]); // random-qubit feeder
        tiles[row * C + OUT_COL] = QCTRL_TILE;
        gates.push([OUT_COL, row, "trash", "free", 0, PI / 4, 0, 0, -1]);
      }
    }

    // Place the seed circuit. Single-qubit gates land on every line (the scored
    // ones too — the player fixes those). Two-qubit interactions go only between
    // adjacent NON-scored lines, so the A/B->C/D path stays solvable.
    var cursor = new Array(n).fill(0);
    var nextCol = function (qs) {
      var m = 0;
      for (var i = 0; i < qs.length; i++) m = Math.max(m, cursor[qs[i]]);
      return m + 1;
    };
    var adjacentFiller = function (a, b) {
      return Math.abs(rowOf(a) - rowOf(b)) === 1 && !isScored(rowOf(a)) && !isScored(rowOf(b));
    };
    var placeSingle = function (col, q, label, angle) {
      var enc = singleEnc(label);
      var rot = (typeof angle === "number") ? angle : enc.rot;
      tiles[rowOf(q) * C + col] = enc.tile;
      gates.push([col, rowOf(q), enc.type, "free", 0, rot, 0, 0, -1]);
    };
    // qControl on the control row + the target gate on the adjacent row.
    var placeControlled = function (col, cq, tq, type, rot) {
      var cr = rowOf(cq), tr = rowOf(tq), orient = (tr > cr) ? 0 /*down*/ : 2 /*up*/;
      tiles[cr * C + col] = QCTRL_TILE;
      gates.push([col, cr, "qControl", "free", orient, 0, 0, 0, -1]);
      tiles[tr * C + col] = (type === "rotate") ? 62 : 68;
      gates.push([col, tr, type, "free", 0, rot, 0, 0, -1]);
    };

    var nSingle = 0, nTwo = 0, depth = 0;
    for (var gi = 0; gi < spec.gates.length; gi++) {
      var g = spec.gates[gi];
      var q0 = g.qubits[0], q1 = g.qubits[1];
      if (q0 >= n || (q1 !== undefined && q1 >= n)) continue;
      if (g.type === "single") {
        var col = nextCol([q0]);
        if (col > LAST_GATE_COL) continue;
        placeSingle(col, q0, g.label, g.angle);
        cursor[q0] = col; nSingle++; depth = Math.max(depth, col);
      } else if (g.type === "cx" || g.type === "cz") {
        if (!adjacentFiller(q0, q1)) continue;
        var colc = nextCol([q0, q1]);
        if (colc > LAST_GATE_COL) continue;
        placeControlled(colc, q0, q1, "qFlip", g.type === "cx" ? PI / 2 : 0);
        cursor[q0] = cursor[q1] = colc; nTwo++; depth = Math.max(depth, colc);
      } else if (g.type === "swap") {
        if (!adjacentFiller(q0, q1)) continue;
        var col0 = nextCol([q0, q1]);
        if (col0 + 2 > LAST_GATE_COL) continue;
        placeControlled(col0, q0, q1, "qFlip", PI / 2);
        placeControlled(col0 + 1, q1, q0, "qFlip", PI / 2);
        placeControlled(col0 + 2, q0, q1, "qFlip", PI / 2);
        cursor[q0] = cursor[q1] = col0 + 2; nTwo++; depth = Math.max(depth, col0 + 2);
      }
    }
    spec.stats = { lines: n, single: nSingle, two: nTwo, depth: depth };

    // Keep the scored channels' seed qubits (rows 5,8 feed A/B); drop the rest of
    // quant1's queue-display ghosts so they don't litter the circuit wires.
    var keepQubits = (def.allQubits || [])
      .map(function (q) { return Array.isArray(q) ? q.slice() : q; })
      .filter(function (p) { return p[1] === 5 || p[1] === 8; });

    // Install deterministically (overwrite any restored board).
    IBOARD._gateList = []; IBOARD._qubitList = []; IBOARD._bitList = [];
    IBOARD._tiles = tiles;
    IBOARD.setAllBits([], JSON.parse(JSON.stringify(keepQubits)), []);
    IBOARD.setAllGates(JSON.parse(JSON.stringify(gates)));
    // Overwrite every saved blueprint so the engine's restore-on-entry can't
    // reintroduce a stale circuit.
    try {
      if (typeof PERSIST0 !== "undefined" && PERSIST0.quant1) {
        for (var b = 0; b < PERSIST0.quant1.tiles.length; b++) {
          PERSIST0.quant1.tiles[b] = tiles.slice();
          PERSIST0.quant1.gates[b] = JSON.parse(JSON.stringify(gates));
        }
      }
    } catch (e) { /* persist layout differs */ }

    // Freeze the camera centered (no quant1 pan) so wires sit on the ports.
    SCENARIO.xCameraLocs = new Array(SCENARIO.xCameraLocs.length || 50).fill(CAM_FX);
    SCENARIO.yCameraLocs = new Array(SCENARIO.yCameraLocs.length || 50).fill(CAM_FY);

    LevelRefresh(SCENARIO.name, IBOARD);
    try {
      if (CANV.scenarioOverlay && CANV.scenarioOverlay.clear) CANV.scenarioOverlay.clear();
      Overlay.createInstruct(CANV.scenarioOverlay.ctx, CANV.scenarioOverlay.w0, CANV.scenarioOverlay.h0);
      if (CANV.scenarioMask && CANV.scenarioMask.clear) CANV.scenarioMask.clear();
      Overlay.createInstruct(CANV.scenarioMask.ctx, CANV.scenarioMask.w0, CANV.scenarioMask.h0, true);
    } catch (e) { /* overlay not ready */ }
    if (typeof UNDOREDO !== "undefined" && UNDOREDO.reset) UNDOREDO.reset();
    STATE.mode = "constructing";

    // Enable the whole gate palette. The greyed LOOK is a Paths.menuGrey overlay
    // that Overlay.createMenu bakes onto the static CANV.menuBack canvas for each
    // isGrey button, once at load, never repainted. Clear the flags AND re-run
    // createMenu to repaint menuBack with no grey overlays; retry briefly because
    // the menu builds lazily and the engine may re-init it late.
    var enableAllGates = function () {
      try {
        SCENARIO.menuGrey = [[0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0]];
        if (typeof MENU === "undefined" || !MENU.buttons || !MENU.buttons.length) return;
        for (var i = 0; i < MENU.buttons.length; i++) MENU.buttons[i].isGrey = 0;
        if (typeof Overlay !== "undefined" && Overlay.createMenu && CANV.menuOverlay && CANV.menuBack) {
          Overlay.createMenu(
            CANV.menuOverlay.ctx, CANV.menuOverlay.w0, CANV.menuOverlay.h0,
            CANV.menuBack.ctx, CANV.menuBack.w0, CANV.menuBack.h0);
        }
      } catch (e) { /* menu not ready */ }
    };
    enableAllGates();
    var gTries = 0;
    var gTimer = setInterval(function () {
      enableAllGates();
      if (++gTries > 12) clearInterval(gTimer);
    }, 250);
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
    var gates = [], nQ = CIRCUIT_ROWS.length, m;
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
    return { gates: gates, nQubits: Math.max(1, Math.min(CIRCUIT_ROWS.length, nQ)) };
  }

  function circuitFromUrl() {
    var nLines = CIRCUIT_ROWS.length;
    var seed = readParam("seed");
    if (seed) {
      var hex = normalizeSeed(seed);
      if (!hex) return null;
      return { mode: "seed", seedHex: hex, gates: generateCircuit(hex, nLines, GEN_MOMENTS), nQubits: nLines };
    }
    var qasm = readParam("qasm");
    if (qasm) {
      var text;
      try { text = b64urlDecode(qasm); } catch (e) { text = decodeURIComponent(qasm); }
      var parsed = parseQasm(text);
      if (!parsed.gates.length) return null;
      return { mode: "qasm", seedHex: null, gates: parsed.gates, nQubits: Math.min(nLines, parsed.nQubits) };
    }
    return null;
  }

  function message(msg) {
    try {
      FIELD.message = msg;
      TIMER.message = TIMER.messageMax;
    } catch (e) { /* board not ready */ }
  }

  // Side panel describing this circuit/seed.
  function setPanel(spec) {
    var info = [];
    if (spec.mode === "seed") info.push("• Seed: " + spec.seedHex.slice(0, 10) + "…" + spec.seedHex.slice(-6));
    else info.push("• Source: OpenQASM");
    var pat = readParam("pattern"), pal = readParam("palette"),
        sig = readParam("sig"), rares = readParam("rares");
    if (pat) info.push("• Pattern: " + pat);
    if (pal) info.push("• Palette: " + pal);
    if (sig) info.push("• Signature: #" + sig.replace(/^#/, ""));
    if (rares) info.push("• Rares: " + rares);
    var st = spec.stats || {};
    info.push("• " + (st.lines || 0) + " circuit lines · " + (st.single || 0) + " gates · " + (st.two || 0) + " interactions");
    info.push("• Scored: A=|0>→C, B=|1>→D");
    info.push("• Win: " + GOAL + " correct outputs");
    try {
      SCENARIO.title = spec.mode === "seed" ? "Quantum Echo" : "QASM Circuit";
      SCENARIO.info = info;
      if (typeof Overlay !== "undefined" && typeof CANV !== "undefined" && CANV.scenario) {
        if (CANV.scenario.clear) CANV.scenario.clear();
        Overlay.createScenarioNew(CANV.scenario.ctx, CANV.scenario.w0, CANV.scenario.h0);
      }
    } catch (e) { /* panel not ready */ }
  }

  function tryLoad() {
    var spec = circuitFromUrl();
    if (!spec) return;
    try {
      loadLevel(spec);
      setPanel(spec);
      message("Press play: send A→C and B→D to score; the seed circuit runs alongside.");
      if (typeof SFX !== "undefined" && SFX.click2) SFX.click2.play();
    } catch (e) {
      message("Could not load circuit from link.");
      if (window.console) console.error("[qubit-factory-link]", e);
    }
  }

  // Wait until the engine has booted, then load.
  function ready() {
    return typeof IBOARD !== "undefined" && typeof InitScenario !== "undefined"
      && typeof FIELD !== "undefined" && FIELD.cols && typeof LevelRefresh !== "undefined"
      && typeof LevelGates !== "undefined";
  }
  if (!location.hash && !location.search) return; // nothing to do
  var tries = 0;
  var timer = setInterval(function () {
    tries++;
    if (ready()) { clearInterval(timer); setTimeout(tryLoad, 600); }
    else if (tries > 200) clearInterval(timer);
  }, 100);
})();
