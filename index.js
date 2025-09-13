// Welcome to
// __________         __    __  .__                               __
// \______   \_____ _/  |__/  |_|  |   ____   ______ ____ _____  |  | __ ____
//  |    |  _/\__  \\   __\   __\  | _/ __ \ /  ___//    \\__  \ |  |/ // __ \
//  |    |   \ / __ \|  |  |  | |  |_\  ___/ \___ \|   |  \/ __ \|    <\  ___/
//  |________/(______/__|  |__| |____/\_____>______>___|__(______/__|__\\_____>
//
// This file can be a nice home for your Battlesnake logic and helper functions.
//
// To get you started we've included code to prevent your Battlesnake from moving backwards.
// For more info see docs.battlesnake.com

import runServer from './server.js';

// info is called when you create your Battlesnake on play.battlesnake.com
// and controls your Battlesnake's appearance
// TIP: If you open your Battlesnake URL in a browser you should see this data
function info() {
  console.log("INFO");

  return {
    apiversion: "1",
    author: "asdf123",
    color: "#FF0000",
    head: "evil",
    tail: "sharp",
  };
}

// start is called when your Battlesnake begins a game
function start(gameState) {
  console.log("GAME START");
}

// end is called when your Battlesnake finishes a game
function end(gameState) {
  console.log("GAME OVER\n");
}

// move is called on every turn and returns your next move
// Valid moves are "up", "down", "left", or "right"
// See https://docs.battlesnake.com/api/example-move for available data
function getNeighbors(pos, board) {
  const neighbors = [];
  const directions = [
    { x: 0, y: 1, move: "up" },
    { x: 0, y: -1, move: "down" },
    { x: -1, y: 0, move: "left" },
    { x: 1, y: 0, move: "right" }
  ];
  
  for (const dir of directions) {
    const newPos = { x: pos.x + dir.x, y: pos.y + dir.y };
    if (newPos.x >= 0 && newPos.x < board.width && newPos.y >= 0 && newPos.y < board.height) {
      neighbors.push({ pos: newPos, move: dir.move });
    }
  }
  return neighbors;
}

function bfs(start, targets, gameState) {
  if (targets.length === 0) return null;
  
  const queue = [{ pos: start, path: [], distance: 0 }];
  const visited = new Set();
  visited.add(`${start.x},${start.y}`);
  
  while (queue.length > 0) {
    const current = queue.shift();
    
    for (const target of targets) {
      if (current.pos.x === target.x && current.pos.y === target.y) {
        return { target, distance: current.distance, firstMove: current.path[0] };
      }
    }
    
    for (const neighbor of getNeighbors(current.pos, gameState.board)) {
      const key = `${neighbor.pos.x},${neighbor.pos.y}`;
      if (!visited.has(key) && isSafePosition(neighbor.pos, gameState, current.distance + 1)) {
        visited.add(key);
        const newPath = current.path.length === 0 ? [neighbor.move] : current.path;
        queue.push({
          pos: neighbor.pos,
          path: newPath,
          distance: current.distance + 1
        });
      }
    }
  }
  
  return null;
}

function isSafePosition(pos, gameState, futureMove = 0) {
  const { board } = gameState;
  
  if (pos.x < 0 || pos.x >= board.width || pos.y < 0 || pos.y >= board.height) {
    return false;
  }
  
  for (const snake of board.snakes) {
    for (let i = 0; i < snake.body.length - Math.min(futureMove, 1); i++) {
      if (snake.body[i].x === pos.x && snake.body[i].y === pos.y) {
        return false;
      }
    }
  }
  
  return true;
}

function calculateFoodScore(health, pathLength) {
  const a = 68.60914;
  const b = 8.51774;
  return a * Math.atan((health - pathLength) / b);
}

function floodFill(start, gameState) {
  const visited = new Set();
  const queue = [start];
  let area = 0;
  
  while (queue.length > 0) {
    const pos = queue.shift();
    const key = `${pos.x},${pos.y}`;
    
    if (visited.has(key)) continue;
    visited.add(key);
    area++;
    
    for (const neighbor of getNeighbors(pos, gameState.board)) {
      const neighborKey = `${neighbor.pos.x},${neighbor.pos.y}`;
      if (!visited.has(neighborKey) && isSafePosition(neighbor.pos, gameState)) {
        queue.push(neighbor.pos);
      }
    }
  }
  
  return area;
}

function simulateGameState(gameState, moves) {
  const newGameState = JSON.parse(JSON.stringify(gameState));
  const directions = {
    up: { x: 0, y: 1 },
    down: { x: 0, y: -1 },
    left: { x: -1, y: 0 },
    right: { x: 1, y: 0 }
  };
  
  for (let i = 0; i < newGameState.board.snakes.length; i++) {
    const snake = newGameState.board.snakes[i];
    const move = moves[i];
    
    if (!move || !directions[move]) continue;
    
    const head = snake.body[0];
    const newHead = {
      x: head.x + directions[move].x,
      y: head.y + directions[move].y
    };
    
    snake.body.unshift(newHead);
    
    const ateFood = newGameState.board.food.some(food => 
      food.x === newHead.x && food.y === newHead.y
    );
    
    if (ateFood) {
      newGameState.board.food = newGameState.board.food.filter(food =>
        !(food.x === newHead.x && food.y === newHead.y)
      );
      snake.health = 100;
    } else {
      snake.body.pop();
      snake.health = Math.max(0, snake.health - 1);
    }
  }
  
  return newGameState;
}

function minimax(gameState, depth, alpha, beta, maximizingPlayer, mySnakeId) {
  if (depth === 0) {
    return evaluateGameState(gameState, mySnakeId);
  }
  
  const moves = ["up", "down", "left", "right"];
  const mySnake = gameState.board.snakes.find(s => s.id === mySnakeId);
  
  if (!mySnake || mySnake.health <= 0) {
    return maximizingPlayer ? -10000 : 10000;
  }
  
  if (maximizingPlayer) {
    let maxEval = -Infinity;
    
    for (const move of moves) {
      const opponentMoves = generateOpponentMoves(gameState, mySnakeId);
      for (const oppMoves of opponentMoves) {
        const allMoves = [move, ...oppMoves];
        const newGameState = simulateGameState(gameState, allMoves);
        const eval_ = minimax(newGameState, depth - 1, alpha, beta, false, mySnakeId);
        maxEval = Math.max(maxEval, eval_);
        alpha = Math.max(alpha, eval_);
        if (beta <= alpha) break;
      }
      if (beta <= alpha) break;
    }
    return maxEval;
  } else {
    let minEval = Infinity;
    
    const opponentMoves = generateOpponentMoves(gameState, mySnakeId);
    for (const oppMoves of opponentMoves) {
      for (const myMove of moves) {
        const allMoves = [myMove, ...oppMoves];
        const newGameState = simulateGameState(gameState, allMoves);
        const eval_ = minimax(newGameState, depth - 1, alpha, beta, true, mySnakeId);
        minEval = Math.min(minEval, eval_);
        beta = Math.min(beta, eval_);
        if (beta <= alpha) break;
      }
      if (beta <= alpha) break;
    }
    return minEval;
  }
}

function generateOpponentMoves(gameState, mySnakeId) {
  const opponents = gameState.board.snakes.filter(s => s.id !== mySnakeId);
  if (opponents.length === 0) return [[]];
  
  const moves = ["up", "down", "left", "right"];
  const combinations = [[]];
  
  for (const opponent of opponents) {
    const newCombinations = [];
    for (const combination of combinations) {
      for (const move of moves) {
        const head = opponent.body[0];
        const directions = { up: { x: 0, y: 1 }, down: { x: 0, y: -1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };
        const newPos = { x: head.x + directions[move].x, y: head.y + directions[move].y };
        
        if (isSafePosition(newPos, gameState)) {
          newCombinations.push([...combination, move]);
        }
      }
    }
    combinations.splice(0, combinations.length, ...newCombinations);
  }
  
  return combinations.slice(0, 10);
}

function evaluateGameState(gameState, mySnakeId) {
  const mySnake = gameState.board.snakes.find(s => s.id === mySnakeId);
  if (!mySnake || mySnake.health <= 0) return -10000;
  
  const myHead = mySnake.body[0];
  let score = 0;
  
  const foodResult = bfs(myHead, gameState.board.food, gameState);
  if (foodResult) {
    score += calculateFoodScore(mySnake.health, foodResult.distance);
  }
  
  const territoryScore = floodFill(myHead, gameState);
  score += territoryScore * 7.60983;
  
  const opponents = gameState.board.snakes.filter(s => s.id !== mySnakeId);
  for (const opponent of opponents) {
    const distance = Math.abs(myHead.x - opponent.body[0].x) + Math.abs(myHead.y - opponent.body[0].y);
    if (mySnake.body.length > opponent.body.length) {
      score += Math.max(0, 10 - distance);
    } else {
      score -= Math.max(0, 10 - distance);
    }
  }
  
  return score;
}

function evaluateMove(move, gameState) {
  const mySnakeId = gameState.you.id;
  const depth = gameState.board.snakes.length > 2 ? 2 : 3;
  
  const directions = {
    up: { x: 0, y: 1 },
    down: { x: 0, y: -1 },
    left: { x: -1, y: 0 },
    right: { x: 1, y: 0 }
  };
  
  const myHead = gameState.you.body[0];
  const newPos = {
    x: myHead.x + directions[move].x,
    y: myHead.y + directions[move].y
  };
  
  if (!isSafePosition(newPos, gameState)) {
    return -10000;
  }
  
  const simulatedState = simulateGameState(gameState, [move]);
  return minimax(simulatedState, depth, -Infinity, Infinity, false, mySnakeId);
}

function move(gameState) {
  const myHead = gameState.you.body[0];
  const myNeck = gameState.you.body[1];
  
  let possibleMoves = ["up", "down", "left", "right"];
  
  if (myNeck) {
    if (myNeck.x < myHead.x) possibleMoves = possibleMoves.filter(m => m !== "left");
    else if (myNeck.x > myHead.x) possibleMoves = possibleMoves.filter(m => m !== "right");
    else if (myNeck.y < myHead.y) possibleMoves = possibleMoves.filter(m => m !== "down");
    else if (myNeck.y > myHead.y) possibleMoves = possibleMoves.filter(m => m !== "up");
  }
  
  let bestMove = null;
  let bestScore = -Infinity;
  
  for (const move of possibleMoves) {
    const score = evaluateMove(move, gameState);
    if (score > bestScore) {
      bestScore = score;
      bestMove = move;
    }
  }
  
  if (!bestMove) {
    const safeMoves = possibleMoves.filter(move => {
      const directions = { up: { x: 0, y: 1 }, down: { x: 0, y: -1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };
      const newPos = { x: myHead.x + directions[move].x, y: myHead.y + directions[move].y };
      return isSafePosition(newPos, gameState);
    });
    
    if (safeMoves.length > 0) {
      bestMove = safeMoves[Math.floor(Math.random() * safeMoves.length)];
    } else {
      bestMove = "down";
    }
  }
  
  console.log(`MOVE ${gameState.turn}: ${bestMove} (score: ${bestScore})`);
  return { move: bestMove };
}

runServer({
  info: info,
  start: start,
  move: move,
  end: end
});
