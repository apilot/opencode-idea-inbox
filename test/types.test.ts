import { describe, expect, test } from "bun:test"
import { glyph, isIdea, isStatus, trim } from "../src/types.js"
import type { Idea } from "../src/types.js"

function validIdea(): Idea {
  return {
    id: "idea_ab12cd",
    text: "текст",
    status: "pending",
    createdAt: "2026-09-13T10:00:00.000Z",
    updatedAt: "2026-09-13T10:00:00.000Z",
    originSessionID: null,
    sessionID: null,
  }
}

describe("isStatus", () => {
  test("accepts the four pipeline statuses and rejects everything else", () => {
    for (const status of ["pending", "in_progress", "done", "documented"]) {
      expect(isStatus(status)).toBeTrue()
    }
    expect(isStatus("archived")).toBeFalse()
    expect(isStatus("")).toBeFalse()
    expect(isStatus(undefined)).toBeFalse()
    expect(isStatus(1)).toBeFalse()
  })
})

describe("isIdea", () => {
  test("accepts a well-formed idea", () => {
    expect(isIdea(validIdea())).toBeTrue()
  })

  test("rejects null, arrays and primitives", () => {
    expect(isIdea(null)).toBeFalse()
    expect(isIdea([validIdea()])).toBeFalse()
    expect(isIdea("idea")).toBeFalse()
  })

  test("rejects wrong field types", () => {
    const base = validIdea()
    expect(isIdea({ ...base, id: 7 })).toBeFalse()
    expect(isIdea({ ...base, text: undefined })).toBeFalse()
    expect(isIdea({ ...base, createdAt: 0 })).toBeFalse()
  })

  test("rejects unknown status", () => {
    expect(isIdea({ ...validIdea(), status: "cancelled" })).toBeFalse()
  })
})

describe("trim", () => {
  test("short text passes through unchanged", () => {
    expect(trim("короткий", 20)).toBe("короткий")
  })

  test("boundary: exactly max chars stays intact", () => {
    expect(trim("abcdef", 6)).toBe("abcdef")
  })

  test("longer text is cut to max-1 chars plus ellipsis", () => {
    const out = trim("семьсимв", 6)
    expect(out).toHaveLength(6) // 5 символов + многоточие
    expect(out.startsWith("семьс")).toBeTrue()
    expect(out.endsWith("…")).toBeTrue()
  })

  test("non-positive max yields empty string (latent bug guard)", () => {
    expect(trim("текст", 0)).toBe("")
    expect(trim("текст", -3)).toBe("")
  })
})

describe("glyph", () => {
  test("maps every status to its own glyph", () => {
    const glyphs = new Set(["○", "◐", "●", "✓"])
    for (const status of ["pending", "in_progress", "done", "documented"] as const) {
      const g = glyph(status)
      expect(glyphs.has(g)).toBeTrue()
      glyphs.delete(g) // каждый глиф уникален
    }
    expect(glyphs.size).toBe(0)
  })
})
