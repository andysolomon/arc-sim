import type { PlayerGameStatLine } from "../stats/types.js";
import type { PbpGameLog, PbpPlay, PbpParticipantRole } from "./types.js";

export interface DerivedPlayerStatLine {
  playerId: string;
  teamId: string;
  statLine: PlayerGameStatLine;
}

export type MutableLine = {
  passing: Required<NonNullable<PlayerGameStatLine["passing"]>>;
  rushing: Required<NonNullable<PlayerGameStatLine["rushing"]>>;
  receiving: Required<NonNullable<PlayerGameStatLine["receiving"]>>;
  defense: Required<NonNullable<PlayerGameStatLine["defense"]>>;
  kicking: Required<NonNullable<PlayerGameStatLine["kicking"]>>;
  punting: Required<NonNullable<PlayerGameStatLine["punting"]>>;
  returns: Required<NonNullable<PlayerGameStatLine["returns"]>>;
  ballSecurity: Required<NonNullable<PlayerGameStatLine["ballSecurity"]>>;
};

export function emptyLine(): MutableLine {
  return {
    passing: {
      comp: 0,
      att: 0,
      yards: 0,
      td: 0,
      int: 0,
      sacked: 0,
      twoPtAtt: 0,
      twoPtConv: 0,
    },
    rushing: { carries: 0, yards: 0, td: 0, long: 0 },
    receiving: {
      rec: 0,
      yards: 0,
      td: 0,
      long: 0,
      targets: 0,
      twoPtAtt: 0,
      twoPtConv: 0,
    },
    defense: {
      tacklesSolo: 0,
      tacklesAst: 0,
      tfl: 0,
      sacks: 0,
      int: 0,
      passDef: 0,
      ff: 0,
      fr: 0,
      defTd: 0,
      intYards: 0,
      safeties: 0,
    },
    kicking: { fgMade: 0, fgAtt: 0, xpMade: 0, xpAtt: 0 },
    punting: { punts: 0, yards: 0, long: 0 },
    returns: {
      krCount: 0,
      krYards: 0,
      krTd: 0,
      prCount: 0,
      prYards: 0,
      prTd: 0,
    },
    ballSecurity: { fumbles: 0, fumblesLost: 0 },
  };
}

function getLine(
  map: Map<string, MutableLine>,
  playerId: string,
): MutableLine {
  let line = map.get(playerId);
  if (!line) {
    line = emptyLine();
    map.set(playerId, line);
  }
  return line;
}

function findParticipant(
  play: PbpPlay,
  role: PbpParticipantRole,
): { playerId: string; teamId: string } | null {
  const p = play.participants.find((x) => x.role === role);
  return p ? { playerId: p.playerId, teamId: p.teamId } : null;
}

function bumpLong(current: number, value: number): number {
  return Math.max(current, value);
}

function isNegativePlay(play: PbpPlay): boolean {
  return play.yardsGained < 0 && (play.playType === "rush" || play.playType === "sack");
}

/**
 * What the log this play came from is known to model.
 *
 * Only `puntReturns` matters so far, and it matters because the same recorded
 * zero means two different things depending on it — see the punt case below.
 */
export interface DerivedFrom {
  puntReturns?: boolean;
}

export function applyPlay(
  map: Map<string, MutableLine>,
  play: PbpPlay,
  models: DerivedFrom = {},
): void {
  switch (play.playType) {
    case "kickoff": {
      const kicker = findParticipant(play, "kicker");
      const returner = findParticipant(play, "returner");
      if (returner) {
        const line = getLine(map, returner.playerId);
        line.returns.krCount += 1;
        /*
         * What he actually brought it back, when the engine wrote it down.
         *
         * Under the `kickReturns` gate `returnYards` is the return; without it
         * `yardsGained` is v1's single collapsed number, which is the yard line
         * the drive started on wearing a returner's name. The reconstruction
         * stands when the gate is off so an existing league's box scores do not
         * move underneath it — `logModels(log, "kickReturns")` tells them apart.
         */
        line.returns.krYards += play.returnYards ?? play.yardsGained;
        /*
         * A kick return touchdown is the RECEIVING team scoring on a play its
         * opponent ran, so it lands in `defensivePoints` and not in `isScoring`
         * — which is why reading `isScoring` here credited nobody, ever.
         */
        if (play.isReturnTd) line.returns.krTd += 1;
      }
      void kicker;
      break;
    }
    case "punt": {
      const punter = findParticipant(play, "kicker");
      const returner = findParticipant(play, "returner");
      if (punter) {
        const line = getLine(map, punter.playerId);
        line.punting.punts += 1;
        line.punting.yards += play.yardsGained;
        line.punting.long = bumpLong(line.punting.long, play.yardsGained);
      }
      /*
       * A punt nobody returned is not a return.
       *
       * `doPuntWithReturn` names a returner on every punt — the array is built
       * before the fair catch, touchback and downed branches run — and 42% of
       * them are never brought back, so the reducer counted 4,252 returns where
       * 2,464 happened and reported 5.6 yards a return against a true 9.6. The
       * yardage was always right; the denominator was counting men who stood
       * and watched.
       *
       * Read here rather than fixed in the engine, and that is not a shortcut.
       * `applyAttrition` reads `play.participants` — for snap cost, and for
       * `floor(roll * participants.length)` to pick who got hurt — so removing
       * a name from a punt changes which player is injured on it and every play
       * after. Measured: identical logs with `injuries` off, divergent with it
       * on. Honest absence in the log is the better shape and is still owed;
       * it is an RNG-shifting change and belongs behind its own gate.
       *
       * Gated on `puntReturns` because the recorded zero means two different
       * things. Under it, zero is a fair catch, a touchback or a ball downed in
       * coverage — the engine modelled the decision. Without it, v1 returned
       * every punt and zero only means the net clamp bit, so reading it as a
       * fair catch would credit an event the engine never simulated.
       */
      const wasReturned = !models.puntReturns || (play.returnYards ?? 0) > 0;
      if (returner && wasReturned) {
        const line = getLine(map, returner.playerId);
        line.returns.prCount += 1;
        /*
         * Read the return when the engine wrote it down; reconstruct only when
         * it did not.
         *
         * The fallback is kept for logs simulated without the `returnStats`
         * gate, and it is wrong — `net * 0.25` is computed from the punt's
         * length rather than from the return, and credits about 2.5x what was
         * simulated. It stays so an existing league's box scores do not change
         * under it, not because it is defensible. `logModels(log, "returnStats")`
         * is how a UI tells the two apart.
         */
        line.returns.prYards +=
          play.returnYards ?? Math.max(0, Math.round(play.yardsGained * 0.25));
        /*
         * The same flag the kickoff reads twenty lines up, and for the same
         * reason: a punt returned to the house is the RECEIVING team scoring on
         * a play its opponent ran, so it lands in `defensivePoints` and leaves
         * `isScoring` false. Reading `isScoring` here credited nobody, ever —
         * 23 punt-return touchdowns in 600 games with no home in any stat line.
         */
        if (play.isReturnTd) line.returns.prTd += 1;
      }
      break;
    }
    case "field_goal":
    case "field_goal_miss": {
      const kicker = findParticipant(play, "kicker");
      if (kicker) {
        const line = getLine(map, kicker.playerId);
        line.kicking.fgAtt += 1;
        if (play.playType === "field_goal") line.kicking.fgMade += 1;
      }
      break;
    }
    case "extra_point":
    case "extra_point_miss": {
      const kicker = findParticipant(play, "kicker");
      if (kicker) {
        const line = getLine(map, kicker.playerId);
        line.kicking.xpAtt += 1;
        if (play.playType === "extra_point") line.kicking.xpMade += 1;
      }
      break;
    }
    case "rush":
    case "kneel": {
      const rusher = findParticipant(play, "rusher");
      if (rusher) {
        const line = getLine(map, rusher.playerId);
        line.rushing.carries += 1;
        line.rushing.yards += play.yardsGained;
        line.rushing.long = bumpLong(line.rushing.long, play.yardsGained);
        if (play.isScoring) line.rushing.td += 1;
      }
      break;
    }
    case "pass_complete": {
      const passer = findParticipant(play, "passer");
      const receiver = findParticipant(play, "receiver");
      if (passer) {
        const line = getLine(map, passer.playerId);
        line.passing.att += 1;
        line.passing.comp += 1;
        line.passing.yards += play.yardsGained;
        if (play.isScoring) line.passing.td += 1;
      }
      if (receiver) {
        const line = getLine(map, receiver.playerId);
        line.receiving.targets += 1;
        line.receiving.rec += 1;
        line.receiving.yards += play.yardsGained;
        line.receiving.long = bumpLong(line.receiving.long, play.yardsGained);
        if (play.isScoring) line.receiving.td += 1;
      }
      break;
    }
    case "pass_incomplete": {
      const passer = findParticipant(play, "passer");
      const receiver = findParticipant(play, "receiver");
      if (passer) {
        getLine(map, passer.playerId).passing.att += 1;
      }
      if (receiver) {
        getLine(map, receiver.playerId).receiving.targets += 1;
      }
      const pd = findParticipant(play, "pass_defender");
      if (pd) getLine(map, pd.playerId).defense.passDef += 1;
      break;
    }
    case "sack": {
      const passer = findParticipant(play, "passer");
      const sacker = findParticipant(play, "sacker");
      if (passer) {
        const line = getLine(map, passer.playerId);
        line.passing.att += 1;
        line.passing.sacked += 1;
        line.passing.yards += play.yardsGained;
      }
      if (sacker) {
        const line = getLine(map, sacker.playerId);
        line.defense.sacks += 1;
        if (isNegativePlay(play)) line.defense.tfl += 1;
      }
      break;
    }
    case "interception": {
      const passer = findParticipant(play, "passer");
      const receiver = findParticipant(play, "receiver");
      const interceptor = findParticipant(play, "interceptor");
      if (passer) {
        const line = getLine(map, passer.playerId);
        line.passing.att += 1;
        line.passing.int += 1;
      }
      if (receiver) {
        getLine(map, receiver.playerId).receiving.targets += 1;
      }
      if (interceptor) {
        const line = getLine(map, interceptor.playerId);
        line.defense.int += 1;
        /*
         * How far he brought it back. The engine has rolled this on every pick
         * since v1 and spotted the ball with it; there was no field to put it
         * in, so 13,265 simulated yards over 600 games went nowhere.
         *
         * `?? 0` and not a reconstruction: a log without `scoringV2` never
         * wrote `returnYards`, and there is nothing in it to derive the return
         * from — `yardsGained` on a pick is the return, but only under the gate
         * that also records it, so guessing would credit the same number twice
         * as often as it is right. Absent stays absent.
         */
        line.defense.intYards += play.returnYards ?? 0;
        /*
         * Pick-six. `defTd` was declared in `emptyLine` and incremented by
         * nothing, so 70 defensive touchdowns in 600 games read as plain
         * interceptions and their 420 points belonged to nobody.
         */
        if (play.isReturnTd) line.defense.defTd += 1;
      }
      break;
    }
    case "two_point_convert":
    case "two_point_fail": {
      /*
       * The try was falling through `default: break` — no attempt, no credit,
       * and 40 conversions worth 80 points with no home in any stat line.
       *
       * Kept in its own fields rather than folded into the passing and
       * receiving lines, which is how a real box score reports it: a two-point
       * try is not a scrimmage down, and counting it as an attempt would move
       * completion percentage on a play that has no down and no distance.
       */
      const converted = play.playType === "two_point_convert";
      const passer = findParticipant(play, "passer");
      const receiver = findParticipant(play, "receiver");
      if (passer) {
        const line = getLine(map, passer.playerId);
        line.passing.twoPtAtt += 1;
        if (converted) line.passing.twoPtConv += 1;
      }
      if (receiver) {
        const line = getLine(map, receiver.playerId);
        line.receiving.twoPtAtt += 1;
        if (converted) line.receiving.twoPtConv += 1;
      }
      break;
    }
    case "safety": {
      /*
       * Two points, and the only ones a defense scores by making a tackle. The
       * engine names the man who made it; the reducer had no case for the play
       * at all, so 18 safeties over 600 games credited nobody.
       *
       * The tackle itself comes from `creditDefense` below, which now runs on
       * every play type rather than on two of them.
       */
      const tackler = findParticipant(play, "tackler_solo");
      if (tackler) getLine(map, tackler.playerId).defense.safeties += 1;
      break;
    }
    default:
      break;
  }

  /*
   * Tackles and fumbles are credited from here rather than from inside the
   * cases, because being wired up case by case is exactly how they came to be
   * missing: `creditDefense` was called from `rush` and `pass_complete` and
   * nowhere else, so the man who made a safety got nothing, and a strip-sack
   * named a fumbler and a recoverer that no stat line ever heard about.
   *
   * Both functions credit only the roles they find, so running them on every
   * play type costs a filter on plays that name neither.
   */
  creditDefense(map, play);
  creditFumble(map, play);
}

function creditDefense(map: Map<string, MutableLine>, play: PbpPlay): void {
  const solo = play.participants.filter((p) => p.role === "tackler_solo");
  const ast = play.participants.filter((p) => p.role === "tackler_ast");
  for (const p of solo) {
    const line = getLine(map, p.playerId);
    line.defense.tacklesSolo += 1;
    if (isNegativePlay(play)) line.defense.tfl += 1;
  }
  for (const p of ast) {
    getLine(map, p.playerId).defense.tacklesAst += 1;
  }
}

function creditFumble(map: Map<string, MutableLine>, play: PbpPlay): void {
  const fumbler = findParticipant(play, "fumbler");
  const recoverer = findParticipant(play, "recoverer");
  if (fumbler) {
    const line = getLine(map, fumbler.playerId);
    line.ballSecurity.fumbles += 1;
    line.ballSecurity.fumblesLost += 1;
  }
  if (recoverer) {
    const line = getLine(map, recoverer.playerId);
    line.defense.fr += 1;
    if (fumbler) line.defense.ff += 1;
    /*
     * A recovery taken to the house. No engine path reaches the end zone this
     * way today — measured at zero over 600 games — but a fumble return
     * touchdown is a scoring play the log's type already permits, and the
     * alternative is the defect this whole change is about: a field that
     * exists, is reachable, and is incremented by nothing.
     */
    if (play.isReturnTd) line.defense.defTd += 1;
  }
}

export function pruneLine(line: MutableLine): PlayerGameStatLine {
  const out: PlayerGameStatLine = {};
  const groups: (keyof MutableLine)[] = [
    "passing",
    "rushing",
    "receiving",
    "defense",
    "kicking",
    "punting",
    "returns",
    "ballSecurity",
  ];
  for (const group of groups) {
    const values = line[group];
    const hasActivity = Object.values(values).some((v) => v !== 0);
    if (hasActivity) out[group] = { ...values };
  }
  return out;
}

export function deriveStatLines(log: PbpGameLog): DerivedPlayerStatLine[] {
  const map = new Map<string, MutableLine>();
  const teamByPlayer = new Map<string, string>();
  // Recorded gates, read as `logModels` reads them: absent or unreadable means
  // the mechanic was not modelled, which is the conservative answer.
  const models: DerivedFrom = { puntReturns: log.features?.puntReturns === true };

  for (const drive of log.drives) {
    for (const play of drive.plays) {
      /*
       * A play wiped out by an accepted penalty officially did not happen (A2).
       * It stays in the log so the drive chart can show what the flag erased,
       * but nobody is credited for it — a 40-yard run negated by holding must
       * not appear in a rushing total, and Epic D's record book reads these
       * totals as history.
       */
      if (play.penalty?.negatesPlay) continue;
      for (const p of play.participants) {
        teamByPlayer.set(p.playerId, p.teamId);
      }
      applyPlay(map, play, models);
    }
  }

  return [...map.entries()].map(([playerId, line]) => ({
    playerId,
    teamId: teamByPlayer.get(playerId) ?? log.homeTeamId,
    statLine: pruneLine(line),
  }));
}

/**
 * Points the box score attributes to the players in it.
 *
 * Invariant 15 in executable form: this equals `homeScore + awayScore` for any
 * log the engine produces. It was 97.1% of it — a pick-six, a punt returned to
 * the house, a two-point try and a safety each scored on the field and landed
 * in nobody's line, 1.1 points a game.
 *
 * Counted from the side that scored, once. A touchdown pass appears in both the
 * passer's `td` and the receiver's, and a two-point try in both `twoPtConv`, so
 * only the receiving half is read — the same convention that keeps `passing.td`
 * out of any team's point total.
 */
export function attributedPoints(lines: DerivedPlayerStatLine[]): number {
  return lines.reduce((sum, { statLine: s }) => {
    const touchdowns =
      (s.rushing?.td ?? 0) +
      (s.receiving?.td ?? 0) +
      (s.returns?.krTd ?? 0) +
      (s.returns?.prTd ?? 0) +
      (s.defense?.defTd ?? 0);
    return (
      sum +
      6 * touchdowns +
      3 * (s.kicking?.fgMade ?? 0) +
      (s.kicking?.xpMade ?? 0) +
      2 * (s.receiving?.twoPtConv ?? 0) +
      2 * (s.defense?.safeties ?? 0)
    );
  }, 0);
}

export function allPlays(log: PbpGameLog): PbpPlay[] {
  return log.drives.flatMap((d) => d.plays);
}

export function sumTeamStatGroup(
  lines: DerivedPlayerStatLine[],
  teamId: string,
  group: keyof PlayerGameStatLine,
  field: string,
): number {
  return lines
    .filter((l) => l.teamId === teamId)
    .reduce((sum, l) => {
      const g = l.statLine[group] as Record<string, number> | undefined;
      return sum + (g?.[field] ?? 0);
    }, 0);
}
