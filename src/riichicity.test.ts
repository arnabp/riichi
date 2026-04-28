import { describe, it, expect } from "bun:test";
import { rankPlayers } from "./riichicity.ts";

describe("rankPlayers", () => {
  it("sorts by points descending and assigns 1-indexed rank", () => {
    const result = rankPlayers([
      { userId: 1, nickname: "Alice", points: 25000 },
      { userId: 2, nickname: "Bob", points: 40000 },
      { userId: 3, nickname: "Carol", points: 10000 },
      { userId: 4, nickname: "Dave", points: 30000 },
    ]);
    expect(result[0]).toMatchObject({ nickname: "Bob", rank: 1 });
    expect(result[1]).toMatchObject({ nickname: "Dave", rank: 2 });
    expect(result[2]).toMatchObject({ nickname: "Alice", rank: 3 });
    expect(result[3]).toMatchObject({ nickname: "Carol", rank: 4 });
  });

  it("handles a single player", () => {
    const result = rankPlayers([{ userId: 1, nickname: "Solo", points: 30000 }]);
    expect(result).toHaveLength(1);
    expect(result[0].rank).toBe(1);
  });

  it("does not mutate the input array", () => {
    const input = [
      { userId: 1, nickname: "A", points: 100 },
      { userId: 2, nickname: "B", points: 200 },
    ];
    rankPlayers(input);
    expect(input[0].nickname).toBe("A");
    expect(input[1].nickname).toBe("B");
  });

  it("maps userId to uid on output", () => {
    const result = rankPlayers([{ userId: 42, nickname: "Test", points: 25000 }]);
    expect(result[0]).toMatchObject({ uid: 42, nickname: "Test", points: 25000 });
  });
});
