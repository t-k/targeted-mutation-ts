import { expect, it } from "vitest";
import { shipsFree } from "../src/shipping";

it("charges shipping on a 4,800 yen order", () => expect(shipsFree(4800)).toBe(false));
it("ships a 5,000 yen order free", () => expect(shipsFree(5000)).toBe(true));
