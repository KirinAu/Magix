import re

with open('/Users/kirinau/Documents/StellaFluxStudio/MagicEffect/backend/src/agent.ts', 'r') as f:
    code = f.read()

# Remove LLMContextMessage interface block
code = re.sub(r'export interface LLMContextMessage \{.*?\n\}\n', '', code, flags=re.DOTALL)

# Remove the llmContext variable
code = re.sub(r'\n\s*// Mirror of what the LLM actually receives each turn\n\s*const llmContext: LLMContextMessage\[\] = \[\];', '', code)

# Remove llmContext.push calls
code = re.sub(r'\n\s*llmContext\.push\([^)]+\);', '', code)

# Fix context_debug to use session.agent.state
new_debug = """
      try {
        const state = (session.agent as any).state || (session.agent as any)._state;
        const sysPrompt = state?.systemPrompt || SYSTEM_PROMPT;
        const msgList = state?.messages || [];
        const formattedMsgs = msgList.map((m: any) => {
          let content = m.content;
          if (Array.isArray(m.content)) {
            content = m.content.map((c: any) => {
              if (c.type === "text") return c.text;
              if (c.type === "tool_call") return `[tool_call: ${c.name}]`;
              if (c.type === "tool_result") return `[tool_result: ${c.name}]\\n${c.content?.map((cc:any)=>cc.text).join('')}`;
              return JSON.stringify(c);
            }).join("\\n");
          }
          return { role: m.role, content };
        });
        sendSSE(res, { type: "context_debug", messages: [{ role: "system", content: sysPrompt }, ...formattedMsgs] });
      } catch (e) {
        console.error("Error formatting context_debug", e);
      }
"""

code = code.replace(
    '// Emit current LLM context snapshot so debug panel shows full message history\n      sendSSE(res, { type: "context_debug", messages: [...llmContext] });',
    new_debug
)

# Remove the text accumulation at turn_end since we don't need it
code = re.sub(r'\n\s*if \(event\.type === "message_update"\) \{[^\}]+\n\s*\}', '', code, flags=re.DOTALL)
code = re.sub(r'\n\s*if \(event\.type === "turn_end"\) \{[^\}]+\n\s*\}', '', code, flags=re.DOTALL)
# Also remove assistantTextBuffer since it's unused
code = re.sub(r'\n\s*let assistantTextBuffer = "";', '', code)

# Modify user message push on the returned object
code = code.replace(
    'addUserMessage: (msg: string) => { llmContext.push({ role: "user", content: msg }); }',
    'addUserMessage: (msg: string) => {}'
)

# Modify the system prompt slightly to ensure models continue thinking
sys_prompt_repl = """### Step 4 — Summarize (MANDATORY — DO NOT SKIP)
**You MUST output a text reply once ok=true and no warnings. Ending without a reply is forbidden.**
Write: what was built, which library was used, and the recommended loop duration."""

sys_prompt_new = """### Step 4 — Summarize (MANDATORY — DO NOT SKIP)
**If ok=true and there are no warnings, you MUST output a final text summary to the user.** Write: what was built, which library was used, and loop duration.

## CRITICAL: Tool Response Handling
When you receive the result of \`commit_code\` or \`str_replace\`, **DO NOT STOP**.
- If the result says "There are errors", you MUST continue by generating a text plan and then calling \`read_code()\`.
- If the result says "ok=true", you MUST output the Step 4 final text summary.
**Stopping directly after receiving a tool result is STRICTLY FORBIDDEN.**"""

code = code.replace(sys_prompt_repl, sys_prompt_new)

# Modify tool output text to force the model to continue
tool_prompt_err = "There are errors. Call read_code() then fix with str_replace."
tool_prompt_err_new = "TASK INCOMPLETE: There are errors. You MUST NOT STOP. Call read_code() then fix with str_replace."

tool_prompt_warn = "ok=true but warnings exist. Call read_code() then fix with str_replace."
tool_prompt_warn_new = "TASK INCOMPLETE: ok=true but warnings exist. You MUST NOT STOP. Call read_code() then fix with str_replace."

tool_prompt_ok = "All checks passed. YOU MUST NOW write a text reply to the user — describe what was built, the library used, and recommended loop duration. Do NOT call any more tools."
tool_prompt_ok_new = "TASK ALMOST COMPLETE: All checks passed. YOU MUST NOW write a text summary to the user! DO NOT STOP without writing your text summary."

code = code.replace(tool_prompt_err, tool_prompt_err_new)
code = code.replace(tool_prompt_warn, tool_prompt_warn_new)
code = code.replace(tool_prompt_ok, tool_prompt_ok_new)


with open('/Users/kirinau/Documents/StellaFluxStudio/MagicEffect/backend/src/agent.ts', 'w') as f:
    f.write(code)
print("done")
