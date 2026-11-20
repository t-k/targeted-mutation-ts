import { expect, it } from "vitest";
import { shipsFree } from "../src/shipping";

it("charges shipping on a 4,999 yen order", () => expect(shipsFree(4999)).toBe(false));
