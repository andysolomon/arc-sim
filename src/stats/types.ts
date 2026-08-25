/** Passing group for one player in one game. */
export interface StatPassing {
  comp?: number;
  att?: number;
  yards?: number;
  td?: number;
  int?: number;
  sacked?: number;
  /**
   * Two-point tries thrown, and the ones that converted.
   *
   * Kept out of `att` / `comp` / `yards` / `td` on purpose — a real box score
   * keeps the try apart from the passing line, and folding it in would move
   * completion percentage on a play that is not a scrimmage down.
   */
  twoPtAtt?: number;
  twoPtConv?: number;
}

export interface StatRushing {
  carries?: number;
  yards?: number;
  td?: number;
  long?: number;
}

export interface StatReceiving {
  rec?: number;
  yards?: number;
  td?: number;
  long?: number;
  targets?: number;
  /** Two-point tries thrown to him, and the ones that converted. */
  twoPtAtt?: number;
  twoPtConv?: number;
}

export interface StatDefense {
  tacklesSolo?: number;
  tacklesAst?: number;
  tfl?: number;
  sacks?: number;
  int?: number;
  passDef?: number;
  ff?: number;
  fr?: number;
  defTd?: number;
  /**
   * Yards he brought an interception back.
   *
   * The engine has always rolled this and spotted the ball with it; until there
   * was a field to put it in, the box score threw it away. Absent on a log the
   * engine never wrote `returnYards` to, which is not the same as zero.
   */
  intYards?: number;
  /** Safeties he made — two points, and the only ones the defense scores by tackle. */
  safeties?: number;
}

export interface StatKicking {
  fgMade?: number;
  fgAtt?: number;
  xpMade?: number;
  xpAtt?: number;
}

export interface StatPunting {
  punts?: number;
  yards?: number;
  long?: number;
}

export interface StatReturns {
  krCount?: number;
  krYards?: number;
  krTd?: number;
  prCount?: number;
  prYards?: number;
  prTd?: number;
}

export interface StatBallSecurity {
  fumbles?: number;
  fumblesLost?: number;
}

/**
 * Canonical per-player box-score line.
 *
 * Derived from the play log — never invented from the final score.
 * Groups are optional; absent means the player had no involvement in that phase.
 */
export interface PlayerGameStatLine {
  passing?: StatPassing;
  rushing?: StatRushing;
  receiving?: StatReceiving;
  defense?: StatDefense;
  kicking?: StatKicking;
  punting?: StatPunting;
  returns?: StatReturns;
  ballSecurity?: StatBallSecurity;
}
