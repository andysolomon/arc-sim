/** Passing group for one player in one game. */
export interface StatPassing {
  comp?: number;
  att?: number;
  yards?: number;
  td?: number;
  int?: number;
  sacked?: number;
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
