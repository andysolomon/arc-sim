/*
 * Conditions, and what they do to a game.
 *
 * `deriveWeather` is the unusual one: it is a pure function of season, week and
 * venue rather than something the caller stores. That is a real contract — a
 * schedule page, a live Gamecast and a re-simulation all have to describe the
 * same afternoon without anyone having written it down — and nothing else in
 * the test suite would notice if it broke.
 */
import { describe, expect, it } from "vitest";
import {
  CLEAR_WEATHER,
  NEUTRAL_MODIFIERS,
  deriveWeather,
  isFairWeather,
  weatherModifiers,
  type Weather,
} from "../weather.js";

const fixture = { seasonId: "2026", week: 8, venueId: "ironhawks" };

describe("deriveWeather", () => {
  it("gives the same fixture the same weather, every time", () => {
    // The whole point: nobody stores this, so everybody has to derive it alike.
    expect(deriveWeather(fixture)).toEqual(deriveWeather(fixture));
  });

  it("gives different venues different weather", () => {
    const here = deriveWeather(fixture);
    const there = deriveWeather({ ...fixture, venueId: "voxel-city" });
    expect(here).not.toEqual(there);
  });

  it("keeps a venue's climate its own across the season", () => {
    /*
     * The venue draw is a fixed offset per venue rather than a fresh roll each
     * week, so a warm-climate program stays warm. Without that, a team could be
     * randomly freezing in week 3 and balmy in week 12, which reads as noise
     * rather than a place.
     */
    const warmest = (venueId: string) => {
      const temps = [1, 4, 8, 12].map((week) => deriveWeather({ ...fixture, week, venueId }).temperatureF);
      return temps.reduce((a, b) => a + b, 0) / temps.length;
    };
    const venues = ["a", "b", "c", "d", "e", "f"].map(warmest);
    // Different venues should genuinely separate, not cluster on one climate.
    expect(Math.max(...venues) - Math.min(...venues)).toBeGreaterThan(5);
  });

  it("cools off as the season wears on", () => {
    const average = (week: number) =>
      ["a", "b", "c", "d", "e", "f", "g", "h"]
        .map((venueId) => deriveWeather({ ...fixture, week, venueId }).temperatureF)
        .reduce((a, b) => a + b, 0) / 8;
    expect(average(13)).toBeLessThan(average(1));
  });

  it("never calls it snow at seventy degrees", () => {
    /*
     * Precipitation type is decided by the temperature rather than by its own
     * roll. Sleet on a warm evening would be a tell that the model is a lookup
     * table rather than a climate.
     */
    for (let week = 1; week <= 14; week++) {
      for (const venueId of ["a", "b", "c", "d", "e", "f", "g", "h"]) {
        const w = deriveWeather({ seasonId: "s", week, venueId });
        if (/snow/i.test(w.condition)) expect(w.temperatureF).toBeLessThanOrEqual(32);
        if (/rain/i.test(w.condition)) expect(w.temperatureF).toBeGreaterThan(32);
      }
    }
  });

  it("stays inside the range a football season actually occupies", () => {
    for (let week = 1; week <= 16; week++) {
      for (const venueId of ["a", "b", "c", "d", "e", "f", "g", "h"]) {
        const w = deriveWeather({ seasonId: "s", week, venueId });
        expect(w.temperatureF).toBeGreaterThan(-20);
        expect(w.temperatureF).toBeLessThan(120);
        expect(w.windMph).toBeGreaterThanOrEqual(0);
        expect(w.windMph).toBeLessThan(60);
        expect(["none", "light", "heavy"]).toContain(w.precipitation);
        expect(w.condition.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("weatherModifiers", () => {
  const clear: Weather = { ...CLEAR_WEATHER };

  it("leaves a clear day completely alone", () => {
    expect(weatherModifiers(clear)).toEqual(NEUTRAL_MODIFIERS);
    expect(isFairWeather(clear)).toBe(true);
  });

  it("ignores an ordinary breeze", () => {
    /*
     * Wind starts counting at 12 mph, not 8. The lower threshold taxed the
     * median late-season game and pulled season scoring below the balance band
     * once weather was switched on for real.
     */
    expect(weatherModifiers({ ...clear, windMph: 10 })).toEqual(NEUTRAL_MODIFIERS);
    expect(weatherModifiers({ ...clear, windMph: 20 }).passAccuracy).toBeLessThan(1);
  });

  it("makes a gale cost the kicker most", () => {
    const gale = weatherModifiers({ ...clear, windMph: 35 });
    expect(gale.kickDistance).toBeLessThan(gale.passAccuracy);
  });

  it("makes rain and cold cost ball security", () => {
    expect(weatherModifiers({ ...clear, precipitation: "heavy" }).fumbleRate).toBeGreaterThan(1);
    expect(weatherModifiers({ ...clear, temperatureF: 10 }).fumbleRate).toBeGreaterThan(1);
  });

  it("compounds its stressors rather than taking the worst one", () => {
    // A freezing night with heavy snow and a hard wind should be genuinely
    // miserable — worse than any one of those alone.
    const wind = weatherModifiers({ ...clear, windMph: 25 });
    const miserable = weatherModifiers({
      temperatureF: 20,
      windMph: 25,
      precipitation: "heavy",
      condition: "Heavy snow",
    });
    expect(miserable.passAccuracy).toBeLessThan(wind.passAccuracy);
    expect(miserable.explosiveRate).toBeLessThan(wind.explosiveRate);
  });

  it("never makes the game unplayable, however bad it gets", () => {
    const worst = weatherModifiers({
      temperatureF: -40,
      windMph: 90,
      precipitation: "heavy",
      condition: "Blizzard",
    });
    expect(worst.passAccuracy).toBeGreaterThanOrEqual(0.6);
    expect(worst.kickDistance).toBeGreaterThanOrEqual(0.7);
    expect(worst.explosiveRate).toBeGreaterThanOrEqual(0.55);
    expect(worst.fumbleRate).toBeLessThanOrEqual(2.5);
  });

  it("never helps anyone", () => {
    // Conditions can only take away. A tailwind that boosted a kicker would
    // need the engine to know which way he was aiming.
    for (const windMph of [0, 15, 40]) {
      for (const temperatureF of [-10, 40, 95]) {
        for (const precipitation of ["none", "light", "heavy"] as const) {
          const m = weatherModifiers({ temperatureF, windMph, precipitation, condition: "" });
          expect(m.passAccuracy).toBeLessThanOrEqual(1);
          expect(m.kickDistance).toBeLessThanOrEqual(1);
          expect(m.explosiveRate).toBeLessThanOrEqual(1);
          expect(m.fumbleRate).toBeGreaterThanOrEqual(1);
        }
      }
    }
  });
});
