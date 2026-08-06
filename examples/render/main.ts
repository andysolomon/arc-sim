/**
 * Renderer demo — simulate a full game headlessly, then watch it.
 *
 *   pnpm demo:render     → http://localhost:5173
 *
 * The whole game is decided before the first frame is drawn. That is the point
 * of the architecture: the scene is a subscriber, not a participant, and the
 * speed controls below change nothing about what happens.
 */
import {
  simulateGameLog,
  seedFor,
  ALL_FEATURES,
  type PbpPlay,
  type PlayerSimProfile,
  type TeamSimProfile,
} from "../../src/index.js";
import {
  FootballScene,
  choreographLog,
  describePlay,
  describeSituation,
  type TeamAppearance,
} from "../../src/render/index.js";

const HOME = { id: "ironhawks", name: "IRONHAWKS", strength: 76 };
const AWAY = { id: "voxel-city", name: "VOXEL CITY", strength: 70 };

const HOME_COLORS: TeamAppearance = { primary: 0x1d3f8f, secondary: 0xf2f4f8 };
const AWAY_COLORS: TeamAppearance = { primary: 0xb3272d, secondary: 0x1b1b1f };

const ROSTER: Array<[string, string, number]> = [
  ["qb1", "QB", 79], ["rb1", "RB", 76], ["rb2", "RB", 70],
  ["wr1", "WR", 78], ["wr2", "WR", 74], ["wr3", "WR", 69],
  ["te1", "TE", 72], ["ol1", "OL", 75], ["ol2", "OL", 71],
  ["de1", "DE", 76], ["dt1", "DT", 72], ["lb1", "LB", 75],
  ["lb2", "LB", 70], ["cb1", "CB", 74], ["cb2", "CB", 71],
  ["s1", "S", 73], ["k1", "K", 72], ["p1", "P", 68],
];

function roster(teamId: string, strength: number): TeamSimProfile {
  const players: PlayerSimProfile[] = ROSTER.map(([id, position, overall]) => ({
    playerId: `${teamId}-${id}`,
    position,
    overall: Math.min(99, overall + Math.round((strength - 73) / 2)),
    depthRank: 1,
  }));
  return {
    teamId,
    strength,
    discipline: strength,
    coach: { aggression: 58 },
    players,
  };
}

const log = simulateGameLog({
  home: roster(HOME.id, HOME.strength),
  away: roster(AWAY.id, AWAY.strength),
  seed: seedFor("pbp", "render-demo", String(Date.now() % 100000)),
  // ALL_FEATURES rather than RECOMMENDED: this one is going to be watched, so
  // it needs `timeline`, the gate that produces `play.events`.
  features: ALL_FEATURES,
});

const playsById = new Map<number, PbpPlay>();
for (const drive of log.drives) {
  for (const play of drive.plays) playsById.set(play.playId, play);
}

const canvas = document.getElementById("stage") as HTMLCanvasElement;
const scene = new FootballScene({
  canvas,
  width: innerWidth,
  height: innerHeight,
  homeTeamId: log.homeTeamId,
  home: HOME_COLORS,
  away: AWAY_COLORS,
});

const el = (id: string) => document.getElementById(id)!;
el("home-name").textContent = HOME.name;
el("away-name").textContent = AWAY.name;
el("home-swatch").style.background = `#${HOME_COLORS.primary.toString(16).padStart(6, "0")}`;
el("away-swatch").style.background = `#${AWAY_COLORS.primary.toString(16).padStart(6, "0")}`;

const clock = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

scene.onPlayStart = (animation) => {
  const play = playsById.get(animation.playId);
  if (!play) return;
  const before = play.preSnap;
  el("home-score").textContent = String(before?.homeScore ?? 0);
  el("away-score").textContent = String(before?.awayScore ?? 0);
  const possession = play.offenseTeamId === log.homeTeamId ? HOME.name : AWAY.name;
  el("situation").textContent =
    `Q${play.quarter} ${clock(play.clockSeconds)} · ${possession} · ${describeSituation(play)}`;
};

scene.onCaption = (text) => {
  el("caption").textContent = text;
};

scene.onPlayEnd = (animation) => {
  const play = playsById.get(animation.playId);
  if (!play) return;
  const item = document.createElement("li");
  const scored = play.pointsScored > 0 || (play.defensivePoints ?? 0) > 0;
  if (scored) item.className = "score";
  item.textContent = `Q${play.quarter} ${clock(play.clockSeconds)} — ${describePlay(play)}`;
  const feed = el("feed");
  feed.prepend(item);
  while (feed.childElementCount > 40) feed.lastElementChild?.remove();
};

scene.enqueue(choreographLog(log));

for (const button of document.querySelectorAll<HTMLButtonElement>("[data-speed]")) {
  button.addEventListener("click", () => {
    scene.speed = Number(button.dataset.speed);
    for (const other of document.querySelectorAll("[data-speed]")) {
      other.setAttribute("aria-pressed", String(other === button));
    }
  });
}
el("restart").addEventListener("click", () => location.reload());

addEventListener("resize", () => scene.setSize(innerWidth, innerHeight));

let last = performance.now();
function frame(now: number) {
  const dt = (now - last) / 1000;
  last = now;
  const idle = scene.frame(dt);
  if (idle && scene.pending === 0) el("caption").textContent = finalText();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

function finalText(): string {
  return `FINAL — ${HOME.name} ${log.homeScore}, ${AWAY.name} ${log.awayScore}`;
}
