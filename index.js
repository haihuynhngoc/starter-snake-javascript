// Battlesnake logic (updated)
// - Adds suffocation check (avoid moving into spaces smaller than your body)
// - Adds choke-region detection and simulates opponents closing exits during lookahead
// - Fixes incorrect s.length usages and cleans minor issues

import runServer from './server.js';

// API handlers
function info() {
  console.log("INFO");
  return {
    apiversion: "1",
    author: "Claude Code AI",
    color: "#FF6B35",
    head: "evil",
    tail: "sharp",
  };
}

function start(gameState) {
  console.log("GAME START");
}

function end(gameState) {
  console.log("GAME OVER\n");
}

/* -------------------- CONFIG / WEIGHTS -------------------- */
const MAX_LOOKAHEAD_DEPTH = 6; // reduced for performance
const MAX_OPPONENT_MOVES = 4; // reduced exponential complexity
const COMBO_CAP = 50; // tighter limit

const SAFE_SPACE_WEIGHT = 1.0;
const SURVIVAL_WEIGHT = 1000;
const FOOD_WEIGHT = 15; // increased food value
const KILL_WEIGHT = 500;
const DEATH_PENALTY = -10000;
const VORONOI_WEIGHT = 2.0; // increased territory control
const HEALTH_WEIGHT = 0.5; // new health consideration
const WALL_HUG_BONUS = 5; // new wall hugging bonus
const TAIL_CHASE_BONUS = 15; // bonus for safe tail chasing
const TRAP_PENALTY = -800; // penalty for walking into traps

// strong penalty for walking into a space smaller than your body (tunable)
const SUFFOCATION_PENALTY = DEATH_PENALTY - 1000; // e.g. -11000
const CHOKE_PENALTY = 300; // reduced to allow more aggressive play

/* -------------------- Movement defs -------------------- */
const moves = [
  { name: "up", dx: 0, dy: 1 },
  { name: "down", dx: 0, dy: -1 },
  { name: "left", dx: -1, dy: 0 },
  { name: "right", dx: 1, dy: 0 },
];

/* -------------------- Main move function -------------------- */

function move(state) {
  const board = state.board;
  const me = state.you;

  // valid in-bounds moves
  const validMoves = moves.filter((m) => isMoveInBounds(me.head, m, board));

  // safe moves (no immediate body collision)
  const safeMoves = validMoves.filter(
    (m) => !collidesWithBodies(simulateHead(me.head, m), board, state)
  );

  // fallback: if no safe moves, pick move maximizing reachable space (return object shape)
  if (safeMoves.length === 0) {
    const fallback = validMoves
      .map((m) => {
        const newHead = simulateHead(me.head, m);
        const score = floodFillScore(newHead, board, state);
        return { move: m.name, score };
      })
      .sort((a, b) => b.score - a.score)[0];
    return { move: fallback?.move ?? validMoves[0].name };
  }

  // Filter moves with head-to-head guaranteed loss / too risky
  const filtered = safeMoves.filter((m) =>
    notGuaranteedHeadToHeadLoss(me, m, board, state)
  );
  const candidateMoves = filtered.length ? filtered : safeMoves;

  // Score candidates with flood-fill, voronoi, lookahead, aggression, immediate food
  const scored = candidateMoves.map((m) => {
    const newHead = simulateHead(me.head, m);

    // safe-space (flood fill)
    const floodScore = floodFillScore(newHead, board, state);

    // Enhanced body-length-aware space validation
    let safeSpaceComponent = 0;
    if (floodScore < me.body.length) {
      safeSpaceComponent = SUFFOCATION_PENALTY;
    } else if (!isViableEscapeSpace(newHead, board, state, me)) {
      // Space exists but geometry is bad for our body length
      safeSpaceComponent = SUFFOCATION_PENALTY * 0.7; // Severe but not death penalty
    } else {
      safeSpaceComponent = SAFE_SPACE_WEIGHT * floodScore;
    }

    // Choke detection: small penalty to avoid going into narrow corridors even if not immediate suffocation
    const choke = detectChokeRisk(newHead, board, state);
    if (choke && safeSpaceComponent !== SUFFOCATION_PENALTY) {
      // only apply this extra penalty if not already replaced by SUFFOCATION_PENALTY
      safeSpaceComponent -= CHOKE_PENALTY;
    }

    const voronoiScore = voronoiControlScore(newHead, board, state, me.id);
    const lookaheadScore = minimaxEvaluateMove(m, state, MAX_LOOKAHEAD_DEPTH);
    const aggressionBonus = aggressionHeuristic(m, state, me);

    // Health-aware food seeking
    const immediateEat = board.food.some((f) => f.x === newHead.x && f.y === newHead.y) ? FOOD_WEIGHT : 0;
    const healthBonus = calculateHealthBonus(me, newHead, board);
    const wallHugBonus = calculateWallHugBonus(newHead, board);
    const tailChaseBonus = calculateTailChaseBonus(me, newHead, board, state);
    const trapPenalty = detectAdvancedTrap(newHead, board, state, me);

    const nearestFoodDist = nearestFoodDistance(newHead, board);
    const towardFoodBonus = shouldSeekFood(me) ? Math.max(0, 10 - nearestFoodDist) : 0;

    // 1v1 endgame adjustment
    const endgameBonus = calculateEndgameBonus(state, newHead, me);

    const totalScore =
      safeSpaceComponent +
      VORONOI_WEIGHT * voronoiScore +
      lookaheadScore +
      aggressionBonus +
      immediateEat +
      towardFoodBonus +
      healthBonus +
      wallHugBonus +
      tailChaseBonus +
      trapPenalty +
      endgameBonus;

    return {
      move: m.name,
      totalScore,
      floodScore,
      voronoiScore,
      lookaheadScore,
      immediateEat,
      choke,
    };
  });

  scored.sort((a, b) => b.totalScore - a.totalScore);
  console.log("MOVE SCORES", scored.slice(0, 4));
  return { move: scored[0].move };
}

/* -------------------- Utilities: positions & collisions -------------------- */

function pointEq(a, b) {
  return a && b && a.x === b.x && a.y === b.y;
}

function simulateHead(head, move) {
  return { x: head.x + move.dx, y: head.y + move.dy };
}

function isMoveInBounds(head, move, board) {
  const p = simulateHead(head, move);
  return p.x >= 0 && p.y >= 0 && p.x < board.width && p.y < board.height;
}

function collidesWithBodies(p, board, state) {
  // Conservatively treat bodies as occupied except tails that will move away
  const occupied = new Set();
  board.snakes.forEach((s) => {
    const grows = willSnakeGrow(s, board);
    for (let i = 0; i < s.body.length; i++) {
      if (i === s.body.length - 1 && !grows) continue; // tail will move
      const b = s.body[i];
      occupied.add(`${b.x},${b.y}`);
    }
  });
  return occupied.has(`${p.x},${p.y}`);
}

function willSnakeGrow(snake, board) {
  return board.food.some((f) => pointEq(f, snake.head));
}

function isCellFree(p, board) {
  if (!p) return false;
  if (p.x < 0 || p.y < 0 || p.x >= board.width || p.y >= board.height) return false;
  for (const s of board.snakes) {
    for (const b of s.body) {
      if (b.x === p.x && b.y === p.y) return false;
    }
  }
  return true;
}

/* -------------------- Flood Fill: reachable space -------------------- */

function floodFillScore(start, board, state) {
  // start: {x,y}
  const width = board.width;
  const height = board.height;
  const q = [];
  const visited = new Set();
  const occupied = new Set();

  // build occupied set conservatively (bodies excluding tails not growing)
  board.snakes.forEach((s) => {
    const grows = willSnakeGrow(s, board);
    for (let i = 0; i < s.body.length; i++) {
      if (i === s.body.length - 1 && !grows) continue;
      const p = s.body[i];
      occupied.add(`${p.x},${p.y}`);
    }
  });

  if (occupied.has(`${start.x},${start.y}`)) return 0;

  q.push(start);
  visited.add(`${start.x},${start.y}`);
  let count = 0;
  while (q.length) {
    const cur = q.shift();
    count++;
    for (const m of moves) {
      const nx = cur.x + m.dx;
      const ny = cur.y + m.dy;
      const key = `${nx},${ny}`;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      if (visited.has(key)) continue;
      if (occupied.has(key)) continue;
      visited.add(key);
      q.push({ x: nx, y: ny });
    }
    if (count > width * height) break;
  }
  return count;
}

/* -------------------- Region & Exit detection for chokes -------------------- */

function findRegionAndExits(start, board, state) {
  // Returns { region: Set("x,y"), exits: Set("x,y") }
  const width = board.width, height = board.height;
  const occupied = new Set();
  board.snakes.forEach(s => s.body.forEach(b => occupied.add(`${b.x},${b.y}`)));

  const region = new Set();
  const q = [start];
  const startKey = `${start.x},${start.y}`;
  region.add(startKey);

  while (q.length) {
    const cur = q.shift();
    for (const m of moves) {
      const nx = cur.x + m.dx, ny = cur.y + m.dy;
      const nkey = `${nx},${ny}`;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
        // out-of-bounds isn't an exit tile; but we'll handle boundaries as not exits
        continue;
      }
      if (occupied.has(nkey)) continue;
      if (!region.has(nkey)) {
        region.add(nkey);
        q.push({ x: nx, y: ny });
      }
    }
  }

  // compute exits: tiles adjacent to region that are free and lead outside region
  const exits = new Set();
  for (const key of region) {
    const [sx, sy] = key.split(',').map(Number);
    for (const m of moves) {
      const nx = sx + m.dx, ny = sy + m.dy;
      const nk = `${nx},${ny}`;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      if (!region.has(nk) && !occupied.has(nk)) {
        // nk is a neighbor tile outside region and free -> candidate exit tile
        exits.add(nk);
      }
    }
  }

  return { region, exits };
}

/* -------------------- Voronoi control -------------------- */

function voronoiControlScore(myNewHead, board, state, myId) {
  const width = board.width;
  const height = board.height;

  const sources = board.snakes.map((s) => ({
    id: s.id,
    head: s.id === myId ? myNewHead : s.head,
  }));

  const dist = Array.from({ length: width }, () =>
    Array.from({ length: height }, () => ({ d: Infinity, owners: [] }))
  );

  const q = [];
  for (const src of sources) {
    const { x, y } = src.head;
    if (x < 0 || y < 0 || x >= width || y >= height) continue;
    dist[x][y].d = 0;
    dist[x][y].owners = [src.id];
    q.push({ x, y, id: src.id });
  }

  while (q.length) {
    const cur = q.shift();
    const curD = dist[cur.x][cur.y].d;
    for (const m of moves) {
      const nx = cur.x + m.dx;
      const ny = cur.y + m.dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const cell = dist[nx][ny];
      const nd = curD + 1;
      if (nd < cell.d) {
        cell.d = nd;
        cell.owners = [cur.id];
        q.push({ x: nx, y: ny, id: cur.id });
      } else if (nd === cell.d) {
        if (!cell.owners.includes(cur.id)) cell.owners.push(cur.id);
      }
    }
  }

  let myTerr = 0;
  let totalTerr = 0;
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      const occupiedCell = board.snakes.some((s) => s.body.some((b) => b.x === x && b.y === y));
      if (occupiedCell) continue;
      const owners = dist[x][y].owners;
      if (!owners || owners.length === 0) continue;
      totalTerr++;
      if (owners.length === 1 && owners[0] === myId) myTerr++;
    }
  }

  const myShare = totalTerr > 0 ? myTerr / totalTerr : 0;
  return myShare * 100;
}

/* -------------------- Head-to-head safety -------------------- */

function notGuaranteedHeadToHeadLoss(me, move, board, state) {
  const newHead = simulateHead(me.head, move);
  for (const s of board.snakes) {
    if (s.id === me.id) continue;
    const dist = Math.abs(s.head.x - newHead.x) + Math.abs(s.head.y - newHead.y);
    if (dist === 0) return false;
    if (dist === 1) {
      // use body length consistently (s.length might not exist)
      if (s.body.length >= me.body.length) {
        return false;
      }
      const hasEscape = moves.some((m) => {
        const p = simulateHead(newHead, m);
        if (p.x === s.head.x && p.y === s.head.y) return false;
        return isCellFree(p, board);
      });
      if (!hasEscape) return false;
    }
  }
  return true;
}

/* -------------------- Minimax-style lookahead (with choke simulation) -------------------- */

function minimaxEvaluateMove(moveObj, state, maxDepth) {
  try {
    const rootState = cloneState(state);
    const myId = rootState.you.id;
    const mySnakeOrig = rootState.board.snakes.find((s) => s.id === myId);
    const myOrigLen = mySnakeOrig ? mySnakeOrig.body.length : 0;

    const myMove = moves.find((mv) => mv.name === moveObj.name);
    if (!myMove) return 0;
    const myNewHead = simulateHead(mySnakeOrig.head, myMove);

    applyMoveToState(mySnakeOrig, myMove, rootState);

    // find region/exits for our new head (pre-opponent moves)
    const { region: rootRegion, exits: rootExits } = findRegionAndExits(myNewHead, rootState.board, rootState);

    // build opponent move choices (top N by flood-fill)
    const opponentChoices = rootState.board.snakes
      .filter((s) => s.id !== myId)
      .map((s) => {
        const vm = moves.filter((m) => isMoveInBounds(s.head, m, rootState.board));
        const safe = vm.filter((m) => !collidesWithBodies(simulateHead(s.head, m), rootState.board, rootState));
        const scored = safe.map((m) => {
          const newHead = simulateHead(s.head, m);
          return { m, sc: floodFillScore(newHead, rootState.board, rootState) };
        });
        scored.sort((a, b) => b.sc - a.sc);
        return scored.slice(0, MAX_OPPONENT_MOVES).map((x) => x.m.name);
      });

    const combos = cartesianProduct(opponentChoices);
    if (combos.length > COMBO_CAP) combos.length = COMBO_CAP;

    let worstScore = Infinity;

    for (const combo of combos) {
      const simState = cloneState(rootState);
      const opponents = simState.board.snakes.filter((s) => s.id !== myId);

      // apply opponent moves
      for (let i = 0; i < opponents.length; i++) {
        const opp = opponents[i];
        const moveName = combo[i];
        const m = moves.find((mv) => mv.name === moveName);
        applyMoveToState(opp, m, simState);
      }

      // After opponents move, check if any opponent moved into rootExits (blocked)
      let closedByOpponent = false;
      if (rootExits && rootExits.size > 0) {
        for (const opp of simState.board.snakes.filter((s) => s.id !== myId)) {
          const key = `${opp.head.x},${opp.head.y}`;
          if (rootExits.has(key)) {
            closedByOpponent = true;
            break;
          }
        }
      }

      // resolve collisions and compute kills
      const beforeResolveOppCount = simState.board.snakes.filter((s) => s.id !== myId).length;
      resolveCollisions(simState);
      const afterResolveOppCount = simState.board.snakes.filter((s) => s.id !== myId).length;
      const killsByUs = Math.max(0, beforeResolveOppCount - afterResolveOppCount);

      // detect if we ate food in this branch
      const ourAfter = simState.board.snakes.find((s) => s.id === myId);
      let ateFoodThisBranch = false;
      if (ourAfter) {
        if (ourAfter.body.length > myOrigLen) ateFoodThisBranch = true;
      }

      // evaluate base
      let baseScore;
      if (maxDepth === 1) {
        baseScore = evaluateStateForMe(simState, myId);
      } else {
        const our = simState.board.snakes.find((s) => s.id === myId);
        if (!our) {
          baseScore = DEATH_PENALTY;
        } else {
          // continue with reduced depth
          const nextDepth = maxDepth - 1;
          const ourValid = moves.filter((m) => isMoveInBounds(our.head, m, simState.board));
          const ourSafe = ourValid.filter((m) => !collidesWithBodies(simulateHead(our.head, m), simState.board, simState));
          if (ourSafe.length === 0) {
            baseScore = evaluateStateForMe(simState, myId);
          } else {
            let bestForUs = -Infinity;
            for (const nextM of ourSafe) {
              const s2 = cloneState(simState);
              const our2 = s2.board.snakes.find((s) => s.id === myId);
              applyMoveToState(our2, nextM, s2);
              resolveCollisions(s2);
              const sc = evaluateStateForMe(s2, myId);
              if (sc > bestForUs) bestForUs = sc;
            }
            baseScore = bestForUs;
          }
        }
      }

      // add food & kill rewards
      let branchScore = baseScore;
      if (ateFoodThisBranch) branchScore += FOOD_WEIGHT;
      if (killsByUs > 0) branchScore += KILL_WEIGHT * killsByUs;

      // If opponent closed an exit that belonged to our initial region, recompute reachable area now
      if (closedByOpponent && ourAfter) {
        const safeSpaceAfter = floodFillScore(ourAfter.head, simState.board, simState);
        if (safeSpaceAfter < ourAfter.body.length) {
          // opponent effectively trapped us -> heavy penalty for this branch
          branchScore = SUFFOCATION_PENALTY;
        } else {
          // reduce score because opponent tried to close us but we still have room
          branchScore -= CHOKE_PENALTY / 2;
        }
      } else {
        // even if not closed by opponent, check suffocation normally
        if (ourAfter) {
          const safeSpaceAfter = floodFillScore(ourAfter.head, simState.board, simState);
          if (safeSpaceAfter < ourAfter.body.length) {
            branchScore = SUFFOCATION_PENALTY;
          }
        }
      }

      if (branchScore < worstScore) worstScore = branchScore;
    }

    if (worstScore === Infinity) worstScore = -9999;
    return worstScore;
  } catch (e) {
    console.error("minimax error", e);
    return 0;
  }
}

/* -------------------- Simulation helpers -------------------- */

// Optimized state cloning - only clone what we need
function cloneState(state) {
  return {
    game: { ...state.game },
    turn: state.turn,
    board: {
      height: state.board.height,
      width: state.board.width,
      food: state.board.food.map(f => ({ ...f })),
      snakes: state.board.snakes.map(s => ({
        id: s.id,
        name: s.name,
        health: s.health,
        body: s.body.map(b => ({ ...b })),
        head: { ...s.head },
        length: s.length
      }))
    },
    you: {
      id: state.you.id,
      name: state.you.name,
      health: state.you.health,
      body: state.you.body.map(b => ({ ...b })),
      head: { ...state.you.head },
      length: state.you.length
    }
  };
}

function cartesianProduct(arr) {
  if (arr.length === 0) return [[]];
  return arr.reduce((acc, cur) => acc.flatMap((a) => cur.map((c) => [...a, c])), [[]]);
}

function applyMoveToState(snake, move, state) {
  if (!snake || !move) return;
  const newHead = { x: snake.head.x + move.dx, y: snake.head.y + move.dy };
  snake.body.unshift(newHead);
  snake.head = newHead;
  const foodIndex = state.board.food.findIndex((f) => pointEq(f, newHead));
  if (foodIndex !== -1) {
    state.board.food.splice(foodIndex, 1);
  } else {
    snake.body.pop(); // remove tail
  }
}

function resolveCollisions(state) {
  const board = state.board;
  const snakes = board.snakes;
  const occupied = new Map(); // key: "x,y", value: array of snakes

  // Remove snakes that hit walls or their own bodies first
  const validSnakes = snakes.filter(snake => {
    const head = snake.head;
    // Check walls
    if (head.x < 0 || head.y < 0 || head.x >= board.width || head.y >= board.height) {
      return false;
    }
    // Check self-collision (head hits body, excluding neck)
    for (let i = 1; i < snake.body.length; i++) {
      if (pointEq(head, snake.body[i])) {
        return false;
      }
    }
    return true;
  });

  // Place remaining heads
  validSnakes.forEach(s => {
    const head = s.head;
    const key = `${head.x},${head.y}`;
    if (!occupied.has(key)) occupied.set(key, []);
    occupied.get(key).push(s);
  });

  const alive = [];

  occupied.forEach((group) => {
    if (group.length === 1) {
      // Single snake in this square, survives
      alive.push(group[0]);
    } else {
      // Multiple heads in same square => head-to-head
      let maxLen = Math.max(...group.map(s => s.body.length));
      let winners = group.filter(s => s.body.length === maxLen);

      if (winners.length === 1) {
        // Only the longest survives
        alive.push(winners[0]);
      }
      // If tie (>=2 longest) → all die (no survivors added)
    }
  });

  // Update state with survivors
  state.board.snakes = alive;
  return alive;
}

/* -------------------- Evaluation & heuristics -------------------- */

function evaluateStateForMe(state, myId) {
  const me = state.board.snakes.find((s) => s.id === myId);
  if (!me) return DEATH_PENALTY;

  let score = 0;
  score += SURVIVAL_WEIGHT;
  score += SAFE_SPACE_WEIGHT * floodFillScore(me.head, state.board, state);
  score += VORONOI_WEIGHT * voronoiControlScore(me.head, state.board, state, myId);
  const myLen = me.body.length;
  const maxOther = state.board.snakes.reduce((acc, s) => (s.id !== myId ? Math.max(acc, s.body.length) : acc), 0);
  score += (myLen - maxOther) * 20;

  const chokeRisk = detectChokeRisk(me.head, state.board, state);
  if (chokeRisk) {
    score -= 500; // discourage entering traps
  }

  return score;
}

function aggressionHeuristic(move, state, me) {
  let bonus = 0;
  const myLen = me.body.length;
  const meanLen = state.board.snakes.reduce((a, s) => a + s.body.length, 0) / Math.max(1, state.board.snakes.length);
  if (myLen > meanLen) {
    const newHead = simulateHead(me.head, moves.find((m) => m.name === move.name));
    const nearestOpp = nearestOpponentDistance(newHead, state.board, me.id);
    bonus += Math.max(0, 30 - nearestOpp);
  }
  bonus += computeFoodDenialBonus(move, state, me);
  return bonus;
}

function nearestOpponentDistance(p, board, myId) {
  let best = Infinity;
  for (const s of board.snakes) {
    if (s.id === myId) continue;
    const d = Math.abs(s.head.x - p.x) + Math.abs(s.head.y - p.y);
    best = Math.min(best, d);
  }
  return best === Infinity ? 1000 : best;
}

function computeFoodDenialBonus(move, state, me) {
  const newHead = simulateHead(me.head, moves.find((m) => m.name === move.name));
  let bonus = 0;
  for (const f of state.board.food) {
    for (const s of state.board.snakes) {
      if (s.id === me.id) continue;
      const dOppFood = Math.abs(s.head.x - f.x) + Math.abs(s.head.y - f.y);
      if (dOppFood === 1) {
        if (pointEq(newHead, f)) bonus += 50;
        const between = isBetween(s.head, f, newHead);
        if (between) bonus += 30;
      }
    }
  }
  return bonus;
}

function isBetween(a, b, c) {
  const da = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  const dc = Math.abs(c.x - b.x) + Math.abs(c.y - b.y);
  return dc < da;
}

function nearestFoodDistance(p, board) {
  if (!board.food || board.food.length === 0) return 1000;
  let best = Infinity;
  for (const f of board.food) {
    const d = Math.abs(f.x - p.x) + Math.abs(f.y - p.y);
    best = Math.min(best, d);
  }
  return best === Infinity ? 1000 : best;
}

/* -------------------- Detect choke risk (legacy simple check) -------------------- */

function detectChokeRisk(start, board, state) {
  // simple quick check — uses findRegionAndExits internally
  try {
    const { region, exits } = findRegionAndExits(start, board, state);
    // if region is small relative to snake or exits <= 1 it's risky
    const my = state.you;
    if (!region || region.size === 0) return true;
    if (region.size < my.body.length) return true;
    if (!exits || exits.size <= 1) return true;
    return false;
  } catch (e) {
    return false;
  }
}

/* -------------------- Health-aware food seeking -------------------- */

function shouldSeekFood(snake) {
  // Seek food if health is getting low - earlier threshold for safety
  return snake.health < 50;
}

function calculateHealthBonus(snake, newHead, board) {
  const nearestFood = nearestFoodDistance(newHead, board);

  // Critical starvation prevention - override other bonuses when very low health
  if (snake.health <= 15) {
    if (nearestFood === 0) return FOOD_WEIGHT * 5; // Massive bonus for immediate food
    if (nearestFood <= 2) return FOOD_WEIGHT * 3; // Strong bonus for very close food
    return FOOD_WEIGHT; // Some bonus for any food when starving
  }

  // Normal health-based food seeking
  if (snake.health > 70) return 0; // Don't prioritize when healthy

  const urgency = Math.max(0, (60 - snake.health) / 60); // 0-1 based on health

  if (nearestFood === 0) {
    return FOOD_WEIGHT * (1 + urgency * 2);
  } else if (nearestFood <= 3) {
    return urgency * 30 / nearestFood; // Increased base bonus
  }

  return 0;
}

/* -------------------- Wall hugging strategy -------------------- */

function calculateWallHugBonus(pos, board) {
  let wallCount = 0;
  if (pos.x === 0 || pos.x === board.width - 1) wallCount++;
  if (pos.y === 0 || pos.y === board.height - 1) wallCount++;
  return wallCount * WALL_HUG_BONUS;
}

/* -------------------- Tail chasing optimization -------------------- */

function calculateTailChaseBonus(snake, newHead, board, state) {
  // Don't chase tail if we need food urgently
  if (snake.health < 40) return 0;

  // Only chase tail if we have enough space and it's relatively safe
  const tail = snake.body[snake.body.length - 1];
  const distToTail = Math.abs(newHead.x - tail.x) + Math.abs(newHead.y - tail.y);

  // Don't chase if too far away
  if (distToTail > 3) return 0;

  // Check if tail will move away (snake not growing)
  const willGrow = board.food.some(f => pointEq(f, snake.head));
  if (willGrow) return 0; // Tail won't move, don't chase

  // Calculate available space from tail position
  const tailSpace = floodFillScore(tail, board, state);

  // Only chase tail if we have enough space and it creates a safe loop
  if (tailSpace >= snake.body.length + 2) {
    // Reduced bonus to not override food seeking
    return (TAIL_CHASE_BONUS * 0.5) / Math.max(1, distToTail);
  }

  return 0;
}

/* -------------------- Advanced trap detection -------------------- */

function detectAdvancedTrap(newHead, board, state, snake) {
  // Don't be overly cautious when we desperately need food
  if (snake.health <= 20) {
    // Only detect the most severe traps when starving
    const opponents = state.board.snakes.filter(s => s.id !== snake.id);
    for (const opponent of opponents) {
      const oppDist = Math.abs(newHead.x - opponent.head.x) + Math.abs(newHead.y - opponent.head.y);
      if (oppDist <= 1 && opponent.body.length >= snake.body.length) {
        return TRAP_PENALTY * 0.5; // Reduced penalty when starving
      }
    }
    return 0; // Allow risky moves when desperate for food
  }

  // Multi-layered trap detection beyond simple choke analysis
  let trapRisk = 0;

  // 1. Detect opponent-controlled regions
  const opponents = state.board.snakes.filter(s => s.id !== snake.id);

  for (const opponent of opponents) {
    const oppDist = Math.abs(newHead.x - opponent.head.x) + Math.abs(newHead.y - opponent.head.y);

    // Check if opponent can block our escape routes
    if (oppDist <= 3) {
      const escapeRoutes = countEscapeRoutes(newHead, board, state);

      if (escapeRoutes <= 2) {
        // Opponent is close and we have few escape routes
        trapRisk += TRAP_PENALTY * 0.2; // Reduced penalty

        // Extra penalty if opponent is longer (can win head-to-head)
        if (opponent.body.length >= snake.body.length) {
          trapRisk += TRAP_PENALTY * 0.3; // Reduced penalty
        }
      }
    }
  }

  // 2. Detect dead-end corridors (reduced penalty)
  const corridorRisk = detectCorridorTrap(newHead, board, state, snake);
  trapRisk += corridorRisk * 0.7; // Reduced corridor penalty

  // 3. Detect potential pincer movements (two opponents converging)
  if (opponents.length >= 2) {
    const pincerRisk = detectPincerTrap(newHead, opponents);
    trapRisk += pincerRisk * 0.8; // Slightly reduced pincer penalty
  }

  return trapRisk;
}

function countEscapeRoutes(pos, board, state) {
  let routes = 0;
  const me = state.you;

  for (const move of moves) {
    const testPos = simulateHead(pos, move);

    if (!isMoveInBounds(pos, move, board)) continue;
    if (collidesWithBodies(testPos, board, state)) continue;

    // Enhanced space validation: check both size and geometry
    if (isViableEscapeSpace(testPos, board, state, me)) {
      routes++;
    }
  }

  return routes;
}

function detectCorridorTrap(pos, board, state, snake) {
  // Check if we're entering a narrow corridor that might become a dead end

  const regionInfo = findRegionAndExits(pos, board, state);
  const { region, exits } = regionInfo;

  // If region is narrow relative to our body length, it's risky
  const regionSize = region.size;
  const bodyLength = snake.body.length;

  if (regionSize < bodyLength * 1.5 && exits.size <= 2) {
    // Small region with few exits - corridor trap risk
    return TRAP_PENALTY * 0.5;
  }

  return 0;
}

function detectPincerTrap(pos, opponents) {
  // Check if two opponents are positioning to trap us

  if (opponents.length < 2) return 0;

  let maxPincerRisk = 0;

  // Check all pairs of opponents
  for (let i = 0; i < opponents.length; i++) {
    for (let j = i + 1; j < opponents.length; j++) {
      const opp1 = opponents[i];
      const opp2 = opponents[j];

      const dist1 = Math.abs(pos.x - opp1.head.x) + Math.abs(pos.y - opp1.head.y);
      const dist2 = Math.abs(pos.x - opp2.head.x) + Math.abs(pos.y - opp2.head.y);

      // Check if opponents are on roughly opposite sides and close
      if (dist1 <= 4 && dist2 <= 4) {
        const oppToOppDist = Math.abs(opp1.head.x - opp2.head.x) + Math.abs(opp1.head.y - opp2.head.y);

        // If opponents are positioned to create a pincer
        if (oppToOppDist >= Math.max(dist1, dist2)) {
          const pincerRisk = TRAP_PENALTY * 0.3 * (1 - Math.min(dist1, dist2) / 4);
          maxPincerRisk = Math.max(maxPincerRisk, pincerRisk);
        }
      }
    }
  }

  return maxPincerRisk;
}

/* -------------------- Body-length-aware space validation -------------------- */

function isViableEscapeSpace(startPos, board, state, snake) {
  // Enhanced space validation that considers body length and geometry
  // Detects "dead space" traps where space exists but wrong shape for snake body

  const bodyLength = snake.body.length;
  const region = floodFillDetailed(startPos, board, state);

  if (region.cells.length < bodyLength + 3) return false; // Need buffer space

  // Analyze space geometry - detect narrow/linear traps
  const geometry = analyzeSpaceGeometry(region.cells, board);

  // Check if space can accommodate snake movement patterns
  return canAccommodateSnakeBody(geometry, bodyLength);
}

function floodFillDetailed(start, board, state) {
  // Enhanced flood fill that returns detailed region info
  const width = board.width;
  const height = board.height;
  const queue = [start];
  const visited = new Set([`${start.x},${start.y}`]);
  const cells = [start];
  const occupied = new Set();

  // Build occupied set
  board.snakes.forEach((s) => {
    const grows = willSnakeGrow(s, board);
    for (let i = 0; i < s.body.length; i++) {
      if (i === s.body.length - 1 && !grows) continue;
      const p = s.body[i];
      occupied.add(`${p.x},${p.y}`);
    }
  });

  while (queue.length) {
    const cur = queue.shift();

    for (const m of moves) {
      const nx = cur.x + m.dx;
      const ny = cur.y + m.dy;
      const key = `${nx},${ny}`;

      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      if (visited.has(key) || occupied.has(key)) continue;

      visited.add(key);
      const newCell = { x: nx, y: ny };
      cells.push(newCell);
      queue.push(newCell);
    }
  }

  return { cells, size: cells.length };
}

function analyzeSpaceGeometry(cells, board) {
  if (cells.length === 0) return { width: 0, height: 0, aspectRatio: 0, density: 0 };

  // Find bounding rectangle
  const minX = Math.min(...cells.map(c => c.x));
  const maxX = Math.max(...cells.map(c => c.x));
  const minY = Math.min(...cells.map(c => c.y));
  const maxY = Math.max(...cells.map(c => c.y));

  const width = maxX - minX + 1;
  const height = maxY - minY + 1;
  const boundingArea = width * height;
  const actualArea = cells.length;

  return {
    width,
    height,
    aspectRatio: Math.max(width, height) / Math.min(width, height),
    density: actualArea / boundingArea, // How "filled" the bounding rectangle is
    minDimension: Math.min(width, height)
  };
}

function canAccommodateSnakeBody(geometry, bodyLength) {
  // Check if space geometry can accommodate snake body movement

  // 1. Minimum width check - space must be wide enough for snake to maneuver
  if (geometry.minDimension < 2) {
    // Linear spaces (1-cell wide) are dangerous unless very short
    return geometry.width * geometry.height <= bodyLength * 0.8;
  }

  // 2. Aspect ratio check - very long/narrow spaces are tricky
  if (geometry.aspectRatio > 5) {
    // Long narrow corridor - check if we can navigate it
    const corridorLength = Math.max(geometry.width, geometry.height);
    const corridorWidth = Math.min(geometry.width, geometry.height);

    // Dangerous if corridor is barely wider than our turning radius
    if (corridorWidth <= 2 && corridorLength < bodyLength * 1.5) {
      return false;
    }
  }

  // 3. Density check - fragmented spaces are harder to navigate
  if (geometry.density < 0.6) {
    // Very fragmented space - need extra room
    return geometry.width * geometry.height >= bodyLength * 2;
  }

  // 4. General viability - space should be significantly larger than body
  const spaceArea = geometry.width * geometry.height * geometry.density;
  return spaceArea >= bodyLength * 1.4;
}

/* -------------------- 1v1 Endgame strategy -------------------- */

function calculateEndgameBonus(state, newHead, me) {
  const opponents = state.board.snakes.filter(s => s.id !== me.id);

  if (opponents.length !== 1) return 0; // Not 1v1

  const opponent = opponents[0];
  const myLen = me.body.length;
  const oppLen = opponent.body.length;

  // If we're longer, be more aggressive
  if (myLen > oppLen) {
    const distToOpp = Math.abs(newHead.x - opponent.head.x) + Math.abs(newHead.y - opponent.head.y);
    return Math.max(0, 50 - distToOpp * 5); // Get closer when we're bigger
  }

  // If opponent is longer, focus on space control and survival
  const voronoiScore = voronoiControlScore(newHead, state.board, state, me.id);
  return voronoiScore * 2; // Double voronoi importance in 1v1
}

/* -------------------- Start server binding -------------------- */

runServer({
  info: info,
  start: start,
  move: move,
  end: end,
});
