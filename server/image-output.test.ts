import { existsSync, readFileSync, rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { materializeImageOutput, renderImageOutputMarkdown } from "./image-output";

const createdPaths: string[] = [];

afterEach(() => {
  while (createdPaths.length > 0) {
    const file = createdPaths.pop();
    if (file !== undefined) rmSync(file, { force: true });
  }
});

function track(path: string): string {
  createdPaths.push(path);
  return path;
}

describe("materializeImageOutput", () => {
  it("writes decoded bytes to a content-hashed file and returns a file URI", () => {
    // "hello" as png bytes stand-in; the hash names the content, not a test id.
    const materialized = materializeImageOutput("aGVsbG8=", "image/png");
    expect(materialized).not.toBeNull();
    if (materialized === null) return;
    expect(materialized.uri).toMatch(/^file:\/\/\//);
    expect(materialized.uri).toMatch(/[0-9a-f]{64}\.png$/);
    expect(existsSync(track(materialized.path))).toBe(true);
    expect(readFileSync(materialized.path, "utf8")).toBe("hello");
  });

  it("reuses the same file for identical bytes", () => {
    const first = materializeImageOutput("aGVsbG8=", "image/png");
    const second = materializeImageOutput("aGVsbG8=", "image/png");
    expect(first).not.toBeNull();
    if (first === null || second === null) return;
    track(first.path);
    expect(second.path).toBe(first.path);
    expect(second.uri).toBe(first.uri);
  });

  it("accepts data-URI payloads by stripping the prefix", () => {
    const materialized = materializeImageOutput(
      "data:image/png;base64,aGVsbG8=",
      "image/png",
    );
    expect(materialized).not.toBeNull();
    if (materialized === null) return;
    expect(readFileSync(track(materialized.path), "utf8")).toBe("hello");
  });

  it("refuses empty payloads and unknown mime types", () => {
    expect(materializeImageOutput("   ", "image/png")).toBeNull();
    expect(materializeImageOutput("aGVsbG8=", "application/octet-stream")).toBeNull();
    expect(materializeImageOutput("aGVsbG8=", null)).not.toBeNull();
  });
});

describe("renderImageOutputMarkdown", () => {
  it("renders a host readable image reference", () => {
    expect(renderImageOutputMarkdown("file:///tmp/x.png")).toBe("![Image](file:///tmp/x.png)");
  });
});
