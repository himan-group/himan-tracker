import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classifyCapability } from "../../src/normalizer/capabilityClassifier.js";

describe("classifyCapability", () => {
  it("preserves explicit non-unknown capability types", () => {
    assert.deepEqual(
      classifyCapability({
        capability_type: "plugin",
        capability_name: "github",
      }),
      {
        type: "plugin",
        name: "github",
        confidence: "exact",
      },
    );
  });

  it("classifies MCP namespace tool names", () => {
    assert.deepEqual(
      classifyCapability({
        capability_name: "mcp__github__create_pull_request",
      }),
      {
        type: "mcp_tool",
        name: "github.create_pull_request",
        confidence: "estimated",
      },
    );
  });

  it("classifies shell execution sources as shell commands", () => {
    assert.deepEqual(
      classifyCapability({
        capability_name: "git status --short",
        source: "shell",
      }),
      {
        type: "shell_command",
        name: "git status --short",
        confidence: "estimated",
      },
    );
  });

  it("classifies known built-in tools", () => {
    assert.deepEqual(
      classifyCapability({
        capability_name: "functions.exec_command",
      }),
      {
        type: "builtin_tool",
        name: "functions.exec_command",
        confidence: "estimated",
      },
    );
    assert.deepEqual(
      classifyCapability({
        capability_name: "Bash",
      }),
      {
        type: "builtin_tool",
        name: "Bash",
        confidence: "estimated",
      },
    );
  });

  it("falls back to unknown for unrecognized capabilities", () => {
    assert.deepEqual(
      classifyCapability({
        capability_name: "custom-capability",
      }),
      {
        type: "unknown",
        name: "custom-capability",
        confidence: "unknown",
      },
    );
  });
});
