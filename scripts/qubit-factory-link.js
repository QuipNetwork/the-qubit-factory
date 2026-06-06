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

  // Every usable interior row is a wire. Rows 5 and 8 are the wired A/B input
  // and C/D output queue ports; the rest are internal lines fed by qCreate.
  // Rows 3-12 are the visible play area (rows 0-2 sit under the top frame, 13 is
  // the bottom frame / alpha-beta strip).
  var ALL_ROWS = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  var OUTPUT_ROWS = [5, 8];
  var isPort = function (row) { return row === 5 || row === 8; };

  // Build the board: feeders on every row (ports take the inputs, others random),
  // the seed's single + adjacent-row qControl interactions, and a trash collector
  // on every line — rows 5/8 are the two output queues, the rest are discards.
  function buildBoardModel(circuit, nQubits) {
    var C = FIELD.cols, R = FIELD.rows;
    var n = Math.min(nQubits, ALL_ROWS.length);
    var rows = ALL_ROWS.slice(0, n);
    var rowOf = function (q) { return rows[q]; };
    var tiles = new Array(C * R).fill(-1);
    for (var q = 0; q < n; q++) {
      var row = rowOf(q);
      for (var c = 0; c < C; c++) tiles[row * C + c] = PLAIN;
    }
    var gateTuples = [];

    // Feeders (counterMax -1 = forever). Port rows take the chosen input
    // (?inputs=zero|plus|bit|random); internal rows get random qubits.
    var inMode = (readParam("inputs") || "zero").toLowerCase();
    var feederRot = inMode === "random" ? 2 : inMode === "bit" ? 1 : inMode === "plus" ? 3 : 0;
    for (var q2 = 0; q2 < n; q2++) {
      var r2 = rowOf(q2);
      tiles[r2 * C + 0] = QCTRL_TILE;
      gateTuples.push([0, r2, "qCreate", "free", 0, isPort(r2) ? feederRot : 2, 0, 0, -1]);
    }

    var outCol = C - 2;                        // output collector column
    var maxGateCol = outCol - 1;
    var cursor = new Array(n).fill(0);
    var truncated = false;
    var nSingle = 0, nTwo = 0, lastCol = 0;

    var placeSingle = function (col, q, label, angle) {
      var enc = singleEnc(label);
      var rot = (typeof angle === "number") ? angle : enc.rot; // QASM ry(theta) override
      tiles[rowOf(q) * C + col] = enc.tile;
      gateTuples.push([col, rowOf(q), enc.type, "free", 0, rot, 0, 0, -1]);
    };
    // qControl on control row + target gate on the adjacent row.
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

    for (var gi = 0; gi < circuit.length; gi++) {
      var g = circuit[gi];
      if (g.type === "single") {
        var col = nextCol([g.qubits[0]]);
        if (col > maxGateCol) { truncated = true; break; }
        placeSingle(col, g.qubits[0], g.label, g.angle);
        cursor[g.qubits[0]] = col;
        nSingle++; lastCol = Math.max(lastCol, col);
      } else if (g.type === "cx" || g.type === "cz") {
        var c1 = g.qubits[0], t1 = g.qubits[1];
        if (Math.abs(c1 - t1) !== 1) continue;          // adjacent rows only
        var colc = nextCol([c1, t1]);
        if (colc > maxGateCol) { truncated = true; break; }
        placeControlled(colc, c1, t1, "qFlip", g.type === "cx" ? PI / 2 : 0);
        cursor[c1] = cursor[t1] = colc;
        nTwo++; lastCol = Math.max(lastCol, colc);
      } else if (g.type === "swap") {
        var a = g.qubits[0], b = g.qubits[1];
        if (Math.abs(a - b) !== 1) continue;
        var col0 = nextCol([a, b]);
        if (col0 + 2 > maxGateCol) { truncated = true; break; }
        placeControlled(col0, a, b, "qFlip", PI / 2);
        placeControlled(col0 + 1, b, a, "qFlip", PI / 2);
        placeControlled(col0 + 2, a, b, "qFlip", PI / 2);
        cursor[a] = cursor[b] = col0 + 2;
        nTwo++; lastCol = Math.max(lastCol, col0 + 2);
      }
    }

    // Every line ends in a trash collector (measure + remove) so the factory
    // runs without jamming; rows 5 and 8 are the two wired output queues.
    for (var q3 = 0; q3 < n; q3++) {
      tiles[rowOf(q3) * C + outCol] = QCTRL_TILE;
      gateTuples.push([outCol, rowOf(q3), "trash", "free", 0, PI / 4, 0, 0, -1]);
    }

    return {
      tiles: tiles, qubits: [], gates: gateTuples, truncated: truncated,
      stats: { qubits: n, single: nSingle, two: nTwo, depth: lastCol, outputs: 2 },
    };
  }

  // Install the model into the live construction board.
  function installCircuit(model) {
    SCENARIO.whichOne = "freeA";
    InitScenario.load("freeA", false);
    // Activate the A/B (left) and C/D (right) channels; leave the bottom
    // alpha/beta channels (4,5) off so the bottom grill doesn't draw.
    SCENARIO.channelsCol = [1, 1, 1, 1, 0, 0];
    SCENARIO.channelsDir = [-1, -1, -1, -1, 0, 0];
    FIELD.channelsDir = [-1, -1, -1, -1, 0, 0];
    for (var r = 0; r < 6; r++) FIELD.channels[r] = Math.round((SCENARIO.channelsDir[r] + 1) / 2);
    LevelRefresh(SCENARIO.name, IBOARD);
    // Clear the freeA design template (it injects a qCreate at [17,0]).
    IBOARD._gateList = [];
    IBOARD._qubitList = [];
    IBOARD._bitList = [];
    IBOARD._tiles = model.tiles;
    IBOARD.setAllBits([], [], []);
    IBOARD.setAllGates(JSON.parse(JSON.stringify(model.gates)));
    LevelRefresh(SCENARIO.name, IBOARD);
    // Redraw the channel overlay so the input/output queue widgets appear.
    try {
      if (CANV.scenarioOverlay && CANV.scenarioOverlay.clear) CANV.scenarioOverlay.clear();
      Overlay.createInstruct(CANV.scenarioOverlay.ctx, CANV.scenarioOverlay.w0, CANV.scenarioOverlay.h0);
      if (CANV.scenarioMask && CANV.scenarioMask.clear) CANV.scenarioMask.clear();
      Overlay.createInstruct(CANV.scenarioMask.ctx, CANV.scenarioMask.w0, CANV.scenarioMask.h0, true);
    } catch (e) { /* overlay not ready */ }
    if (typeof UNDOREDO !== "undefined" && UNDOREDO.reset) UNDOREDO.reset();
    STATE.mode = "constructing";
  }

  // Back-to-basics scored level: take the native quant1 ("QI.A: Inversion")
  // device level — which already wires A->C and B->D, streams from QINPUTS, and
  // scores via qCompare collectors at col 18 — and reduce it to a trivial pass-
  // through. We keep quant1's native board shape (so the camera stays at its
  // native framing and the wires line up with the A/B/C/D ports), then:
  //   - fill the interior of rows 5 & 8 with straight wire (cols 1..C-2),
  //   - drop quant1's locked transformation gates (the qFlip/rotate at cols 3-5)
  //     so the input flows to the output unchanged,
  //   - feed constant inputs (A = |0>, B = |1>),
  //   - enable the whole gate palette (menuGrey 0 = available, 1 = greyed).
  // qCompare expects output == original input, so a bare wire wins trivially;
  // the player can then drop gates in and watch the score react.
  // Camera focus tile (board col,row the view centers on). quant1 pans from (5,4)
  // for its wide puzzle; a fixed focus that yields cameraX=cameraY=0 centers our
  // compact 2-line board in the play frame. From the engine's camera formula
  // (cameraX = tileW*(6-FX)+leftMargin, cameraY = tileH*(2.5-FY)) with
  // leftMargin = tileW/2, that is FX = 6.5, FY = 2.5.
  var CAM_FX = 6.5, CAM_FY = 2.5;

  function loadScoredLevel(spec, goal) {
    SCENARIO.whichOne = "quant1";
    InitScenario.load("quant1", false);          // scenario config + device + scoring
    var C = FIELD.cols;

    // PRISTINE quant1 board, independent of the player's saved "quant1" blueprint
    // in localStorage (the engine restores PERSIST0[name].tiles/gates over the def
    // on entry; building from the saved state corrupts the level). LevelGates()
    // always returns the level's authored tiles/gates.
    var def = LevelGates("quant1", false);

    // Constant streams: A = |0> (queue index 0 = angle 0), B = |1> (index 8 = pi).
    var N = 100;
    SCENARIO.QINPUTS[0] = new Array(N).fill(0);
    SCENARIO.QINPUTS[1] = new Array(N).fill(8);
    SCENARIO.maxTrials = goal; SCENARIO.numCorrect = goal;

    // Enable the full gate palette. 0 = available, 1 = greyed/disabled.
    SCENARIO.menuGrey = [[0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0]];
    try { SCENARIO.editable = BoardData.makeEditable(true, [-1, -1, -1, -1, 0, 0], 0); } catch (e) {}

    // Straight A->C (row 5) and B->D (row 8) wires from the pristine tiles: keep
    // the port tiles at col 0 and col C-1, fill the interior with plain wire.
    var tiles = def.tiles.slice();
    [5, 8].forEach(function (row) {
      for (var c = 1; c <= C - 2; c++) tiles[row * C + c] = PLAIN;
    });
    // Keep only the streaming machinery: corner qCreate queue feeders + the C/D
    // qCompare collectors. Drop the pre-placed transformation gates so each input
    // reaches its collector unchanged (qCompare expects output == original input).
    var gates = def.allGates
      .map(function (g) { return Array.isArray(g) ? g.slice() : g.pack(); })
      .filter(function (p) { return p[2] === "qCompare" || p[2] === "qCreate"; });

    // Apply deterministically, overwriting whatever was restored.
    IBOARD._gateList = [];
    IBOARD._tiles = tiles;
    IBOARD.setAllGates(JSON.parse(JSON.stringify(gates)));

    // Overwrite every saved blueprint so the engine's restore-on-entry / play loop
    // can never reintroduce a stale circuit.
    try {
      if (typeof PERSIST0 !== "undefined" && PERSIST0.quant1) {
        for (var b = 0; b < PERSIST0.quant1.tiles.length; b++) {
          PERSIST0.quant1.tiles[b] = tiles.slice();
          PERSIST0.quant1.gates[b] = JSON.parse(JSON.stringify(gates));
        }
      }
    } catch (e) { /* persist layout differs */ }

    // Freeze the camera (no pan) on a centered focus so wires sit on the ports.
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

    // Enable the whole gate palette. The greyed LOOK is a `Paths.menuGrey` overlay
    // that `Overlay.createMenu` paints onto the static CANV.menuBack canvas for each
    // button whose `isGrey` is set — baked ONCE at load (with quant1's mostly-grey
    // default), never repainted. So flipping menuGrey/isGrey alone doesn't change
    // the picture. Clear the flags AND re-run createMenu to repaint menuBack with no
    // grey overlays. Retry briefly: the menu builds lazily and may re-init late.
    var enableAllGates = function () {
      try {
        SCENARIO.menuGrey = [[0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0]];
        if (typeof MENU === "undefined" || !MENU.buttons || !MENU.buttons.length) return;
        for (var i = 0; i < MENU.buttons.length; i++) MENU.buttons[i].isGrey = 0;
        if (typeof Overlay !== "undefined" && Overlay.createMenu &&
            CANV.menuOverlay && CANV.menuBack) {
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
      // Fill all 12 interior rows; keep depth small so it fits the screen.
      return { mode: "seed", seedHex: hex, gates: generateCircuit(hex, 12, 10), nQubits: 12 };
    }
    var qasm = readParam("qasm");
    if (qasm) {
      var text;
      try { text = b64urlDecode(qasm); } catch (e) { text = decodeURIComponent(qasm); }
      var parsed = parseQasm(text);
      if (!parsed.gates.length) return null;
      return { mode: "qasm", seedHex: null, gates: parsed.gates, nQubits: Math.min(12, parsed.nQubits) };
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
    info.push("• " + st.qubits + " lines · " + st.single + " gates · " + st.two + " interactions");
    var im = (readParam("inputs") || "zero").toLowerCase();
    var inLabel = im === "random" ? "random" : im === "bit" ? "random bits" : im === "plus" ? "|+>" : "|0>";
    info.push("• Inputs: " + inLabel + " on A/B, random on internal lines");
    info.push("• 2 output queues (C,D) + trash");
    info.push("• Goal: 20 zeros in each output queue");
    try {
      SCENARIO.title = spec.mode === "seed" ? "Quantum Echo" : "QASM Circuit";
      SCENARIO.info = info;
      // The panel is cached at load; redraw it so our text actually shows.
      if (typeof Overlay !== "undefined" && typeof CANV !== "undefined" && CANV.scenario) {
        if (CANV.scenario.clear) CANV.scenario.clear();
        Overlay.createScenarioNew(CANV.scenario.ctx, CANV.scenario.w0, CANV.scenario.h0);
      }
    } catch (e) { /* panel not ready */ }
  }

  // Info panel for the scored (quant1-piggyback) level.
  function setScoredPanel(spec, goal) {
    var info = [];
    if (spec.mode === "seed") info.push("• Seed: " + spec.seedHex.slice(0, 10) + "…" + spec.seedHex.slice(-6));
    var pat = readParam("pattern"), pal = readParam("palette"), sig = readParam("sig");
    if (pat) info.push("• Pattern: " + pat);
    if (pal) info.push("• Palette: " + pal);
    if (sig) info.push("• Signature: #" + sig.replace(/^#/, ""));
    info.push("• Inputs: A=|0>, B=|1>");
    info.push("• Goal: pass A->C and B->D unchanged");
    info.push("• Win: " + goal + " correct outputs");
    try {
      SCENARIO.title = "Quantum Echo";
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
      var mode = (readParam("mode") || "play").toLowerCase();
      if (mode === "sandbox") {
        var model = buildBoardModel(spec.gates, spec.nQubits);
        installCircuit(model);
        setPanel(spec, model);
        message("Circuit loaded! Press play.");
      } else {
        var goal = parseInt(readParam("goal") || "20", 10) || 20;
        loadScoredLevel(spec, goal);
        setScoredPanel(spec, goal);
        message("Press play: send A->C and B->D. The wire already solves it.");
      }
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
