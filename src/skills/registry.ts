import type { Skill, SubAgentType } from '@/types/ec9v3';

export interface SkillMatch {
  skill: Skill;
  matchedPatterns: string[];
}

export const SKILLS: Skill[] = [
  {
    name: 'reliable-file-editing',
    description: 'Permanent read-before-edit workflow for safe targeted source edits',
    version: '1.0.0',
    triggerPatterns: [
      '.*',
    ],
    instructions: `## Reliable File Editing Skill
This skill is always active for coding work.

Rules:
1. Before editing an existing file, call read_file for that exact path.
2. Prefer edit_file or multi_edit for existing files. Do not use create_file to replace existing files.
3. Make the smallest targeted edit that solves the problem.
4. If exact old_text matching fails, read the file again with numbered:true.
5. After numbered read_file, use edit_file with start_line/end_line/new_text for replace_range-style edits.
6. If a source file is broadly malformed, read it first, then use edit_file with replace_entire_file:true. Do not delete and recreate it.
7. Do not use shell commands, redirection, del/rm, scripts, or temporary alternate source files to escape a failed edit.
8. After every source edit, run the relevant check again before claiming success.`,
    tools: ['read_file', 'edit_file', 'multi_edit', 'create_file', 'grep', 'glob', 'shell_command'],
    subAgents: [],
  },
  {
    name: 'javascript-debugging',
    description: 'Write and debug browser JavaScript, HTML event handlers, DOM behavior, and Node syntax/runtime checks',
    version: '1.0.0',
    triggerPatterns: [
      'javascript', 'js\\b', 'app\\.js', 'node --check', 'browser.*app',
      'browser calculator', 'html.*button', 'onclick', 'dom', 'frontend.*bug',
      'static.*site', 'playwright', 'keyboard support',
    ],
    instructions: `## JavaScript Writing And Debugging Skill
Use this only when JavaScript is actually the right language, especially browser UI, DOM, HTML handlers, or Node scripts.

Writing rules:
1. Do not choose JavaScript just because the user asked for a generic calculator or CLI tool. Use JavaScript for browser/DOM work or Node scripts.
2. Keep browser JavaScript simple: one small state object, explicit functions, no clever one-line logic, no eval/Function for calculator math.
3. Prefer data-action/data-value buttons plus addEventListener over inline onclick attributes.
4. If existing HTML uses inline handlers such as onclick="appendNumber('1')", expose those functions on window or remove the inline handlers and bind events in JavaScript.
5. Do not hide required HTML handlers inside an IIFE unless they are explicitly exported to window.
6. Avoid undeclared variables, mixed global/local state, stale DOM ids, malformed self-closing button tags, and global display strings that lose decimal context.
7. For calculators, implement operations as explicit functions over numeric state. Test decimals before claiming done.

Browser calculator state pattern:
- State should look like { displayValue: '0', firstOperand: null, operator: null, waitingForSecondOperand: false }.
- appendDigit replaces displayValue when waitingForSecondOperand is true; otherwise appends to the current display string.
- inputDecimal checks only the current displayValue for '.', not the whole expression string.
- chooseOperator stores Number(displayValue), stores the operator, then sets waitingForSecondOperand true.
- calculate computes firstOperand operator Number(displayValue), handles division by zero, then updates displayValue.
- Do not build a full expression string and eval it for simple calculators.
- Use valid button markup: <button type="button" data-action="add">+</button>. Never self-close button tags.

Debugging workflow:
1. Run node --check on JavaScript files after edits.
2. For browser apps, run a browser-like smoke test with Playwright by using node directly, not npx. Example pattern:
   node -e "const { chromium } = require('playwright'); /* open file://.../index.html, click buttons, assert display values */"
3. The smoke test must check at least one decimal case, one keyboard case, one operator case, and one error case when relevant.
4. Treat page errors such as "function is not defined", "Cannot read properties of null", malformed DOM, and missing element ids as real failures.
5. A syntax-only pass is not enough for browser UI. Runtime behavior must be checked after the final edit before PASS/FIXED.
6. On Windows shell_command uses PowerShell. Run commands one at a time; do not use &&, ||, heredocs, or npx.ps1.`,
    tools: ['read_file', 'edit_file', 'multi_edit', 'grep', 'glob', 'shell_command'],
    subAgents: [],
  },
  {
    name: 'llm',
    description: 'AI chat completions and conversational AI capabilities',
    version: '1.0.0',
    triggerPatterns: [
      'chatbot', 'chat bot', 'ai assistant', 'conversational ai',
      'generate text', 'summarize', 'rephrase', 'paraphrase',
      'text generation', 'language model', 'prompt engineering',
    ],
    instructions: `## LLM Skill
You have access to a local LLM via LMStudio. Use the shell_command tool to interact with it via curl, or use the existing chat API.
For text generation tasks, provide well-structured prompts and process the responses carefully.
Support multi-turn conversations with proper context management.`,
    tools: ['shell_command'],
    subAgents: [],
  },
  {
    name: 'web-search',
    description: 'Real-time web search for current information',
    version: '1.0.0',
    triggerPatterns: [
      'search the web', 'look up', 'find current', 'latest',
      'what is the latest', 'search for', 'google', 'bing search',
      'find information about', 'current events', 'news about',
    ],
    instructions: `## Web Search Skill
Use the web_search tool to find current information. Best practices:
1. Formulate clear, specific search queries
2. If initial results are insufficient, reformulate and search again
3. Always cite sources with URLs from search results
4. Cross-reference multiple sources when possible
5. Summarize findings clearly with source links`,
    tools: ['web_search', 'read_webpage'],
    subAgents: [],
  },
  {
    name: 'web-reader',
    description: 'Extract and parse content from web pages',
    version: '1.0.0',
    triggerPatterns: [
      'read this webpage', 'summarize this article', 'scrape this url',
      'read this url', 'extract content from', 'parse this page',
      'what does this page say', 'get content from',
    ],
    instructions: `## Web Reader Skill
Use the read_webpage tool to extract content from URLs. Best practices:
1. Handle different page types: articles, docs, wikis, forums
2. Strip navigation/footers for clean content
3. If content is truncated, recommend pagination
4. Structure extracted content logically
5. Preserve important metadata (title, dates)`,
    tools: ['read_webpage', 'web_search'],
    subAgents: [],
  },
  {
    name: 'agent-browser',
    description: 'Headless browser automation for complex web interactions',
    version: '1.0.0',
    triggerPatterns: [
      'automate.*website', 'fill.*form', 'take.*screenshot',
      'browser.*automation', 'web.*automation', 'scrape.*data',
      'interact.*website', 'click.*button', 'login.*website',
    ],
    instructions: `## Agent Browser Skill
For complex web interactions, use shell_command with a headless browser tool.
1. Use puppeteer or playwright via shell_command
2. Automate multi-step workflows: login, navigation, data extraction
3. Handle dynamic content and SPAs
4. Take screenshots at key points
5. Extract structured data from pages`,
    tools: ['shell_command'],
    subAgents: ['general-purpose'],
  },
  {
    name: 'pdf',
    description: 'PDF creation, text extraction, merging, and splitting',
    version: '1.0.0',
    triggerPatterns: [
      'create.*pdf', 'extract.*pdf', 'merge.*pdf', 'split.*pdf',
      'pdf.*form', 'read.*pdf', 'pdf.*document', 'fill.*pdf',
      'generate.*pdf', 'pdf.*report',
    ],
    instructions: `## PDF Skill
Use shell_command to work with PDFs. Available approaches:
1. Use \`pdf-parse\` for text extraction
2. Use \`pdf-lib\` for creation and manipulation
3. Install dependencies as needed via npm
4. Always save output to the working directory
5. Report file paths back to the user`,
    tools: ['shell_command', 'create_file', 'read_file'],
    subAgents: [],
  },
  {
    name: 'docx',
    description: 'Word document creation, editing, and analysis',
    version: '1.0.0',
    triggerPatterns: [
      'create.*word', 'create.*docx', 'write.*report',
      'edit.*document', 'word.*document', 'docx.*file',
      'tracked changes', 'write.*proposal', 'create.*letter',
    ],
    instructions: `## DOCX Skill
Use the docx npm package to create and edit Word documents.
1. Use \`docx\` package for document creation
2. Support headings, lists, tables, images
3. Preserve formatting when editing existing docs
4. Save to working directory and report paths`,
    tools: ['shell_command', 'create_file', 'read_file'],
    subAgents: [],
  },
  {
    name: 'pptx',
    description: 'PowerPoint presentation creation and editing',
    version: '1.0.0',
    triggerPatterns: [
      'create.*presentation', 'create.*slides', 'make.*pptx',
      'powerpoint', 'slide.*deck', 'create.*ppt',
      'presentation.*template', 'add.*slides',
    ],
    instructions: `## PPTX Skill
Use pptxgenjs for PowerPoint creation.
1. Use \`pptxgenjs\` package for creating presentations
2. Support multiple layouts, transitions, and themes
3. Add text, images, charts, and shapes
4. Include speaker notes
5. Save and report file paths`,
    tools: ['shell_command', 'create_file'],
    subAgents: [],
  },
  {
    name: 'xlsx',
    description: 'Spreadsheet creation, formulas, data analysis',
    version: '1.0.0',
    triggerPatterns: [
      'create.*spreadsheet', 'create.*excel', 'xlsx.*file',
      'analyze.*data', 'build.*chart', 'spreadsheet.*formula',
      'pivot.*table', 'data.*visualization', 'csv.*convert',
    ],
    instructions: `## XLSX Skill
Use exceljs for spreadsheet operations.
1. Use \`exceljs\` package for creating/editing spreadsheets
2. Support formulas, formatting, and conditional formatting
3. Create charts (bar, line, pie, scatter)
4. Handle CSV import/export
5. Save and report file paths`,
    tools: ['shell_command', 'create_file', 'read_file'],
    subAgents: [],
  },
  {
    name: 'finance',
    description: 'Financial data, stock queries, and market analysis',
    version: '1.0.0',
    triggerPatterns: [
      'stock price', 'market data', 'company.*financial',
      'analyze.*stock', 'portfolio', 'dividend', 'p/e ratio',
      'market.*analysis', 'financial.*report', 'revenue',
    ],
    instructions: `## Finance Skill
Use web_search to find current financial data.
1. Search for real-time stock prices
2. Look up company financials (revenue, earnings, P/E)
3. Analyze market trends from search results
4. Present data in tables when appropriate
5. Always note the date of the data and cite sources`,
    tools: ['web_search', 'read_webpage'],
    subAgents: [],
  },
  {
    name: 'fullstack-dev',
    description: 'Full Next.js development workflow',
    version: '1.0.0',
    triggerPatterns: [
      'build.*web app', 'create.*next.js', 'full.*stack',
      'react.*component', 'api.*route', 'database.*schema',
      'deploy.*app', 'create.*dashboard', 'build.*feature',
    ],
    instructions: `## Full-Stack Dev Skill
Build production-ready web applications following these practices:
1. **Framework**: Next.js with App Router and TypeScript
2. **Styling**: Tailwind CSS with shadcn/ui components
3. **Database**: Prisma ORM with SQLite
4. **State**: Zustand for client state, React Query for server state
5. **API**: REST API routes with proper error handling
6. **Testing**: Write frontend first so users see progress
7. **Documentation**: Document all changes in a worklog
8. Always read existing code before modifying
9. Follow Next.js App Router conventions strictly`,
    tools: ['create_file', 'read_file', 'edit_file', 'multi_edit', 'delete_file', 'grep', 'glob', 'shell_command', 'list_directory'],
    subAgents: ['full-stack-developer', 'explore', 'plan'],
  },
  {
    name: 'skill-creator',
    description: 'Create, modify, and optimize skills',
    version: '1.0.0',
    triggerPatterns: [
      'create.*skill', 'new.*skill', 'improve.*skill',
      'optimize.*skill', 'test.*skill', 'skill.*framework',
    ],
    instructions: `## Skill Creator Skill
Meta-skill for creating and managing other skills.
1. Analyze capability needs and design skills
2. Write trigger patterns for accurate activation
3. Create comprehensive instruction sets
4. Test skill activation with sample messages
5. Optimize trigger patterns to reduce false positives`,
    tools: ['create_file', 'read_file', 'edit_file', 'grep', 'glob'],
    subAgents: [],
  },
  {
    name: 'skill-vetter',
    description: 'Security review for skills',
    version: '1.0.0',
    triggerPatterns: [
      'review.*skill.*safe', 'skill.*security', 'vet.*skill',
      'skill.*audit', 'check.*skill.*safety',
    ],
    instructions: `## Skill Vetter Skill
Security review for skills before activation:
1. Check tool permission scope
2. Detect suspicious patterns (data exfiltration, privilege escalation)
3. Review for hardcoded credentials
4. Verify file operations are scoped
5. Flag shell_command usage without justification
6. Approve, reject, or flag with recommendations`,
    tools: ['read_file', 'grep', 'glob'],
    subAgents: [],
  },
  {
    name: 'document-pattern',
    description: 'Permanently document a project-specific pattern in AGENTS.md',
    version: '1.0.0',
    triggerPatterns: [
      'remember this',
      'document this pattern',
      'save this approach',
      "don't tell you again",
      'add this to memory',
      'note this pattern',
      'save this pattern',
    ],
    instructions: `The user wants to permanently document a pattern for this project.
Use the create_file or edit_file tool to add ONE new entry to AGENTS.md in the
working directory. Do not create the file from scratch if it exists - append only.

Entry format:
## [short title] — added [today's date]
**When:** [situation that triggers this pattern]
**Do:** [what to do]
**Example:** [one concrete example, optional]
**Avoid:** [one anti-pattern, optional]

---

Rules:
- Keep the entry under 200 words.
- Document only project-specific decisions, not general programming advice.
- Do not rewrite or reorganize existing entries.
- After writing, confirm to the user what was saved and where.`,
    tools: ['create_file', 'edit_file', 'read_file'],
    subAgents: [],
  },
];

export function matchSkills(userMessage: string): SkillMatch[] {
  const lowerMsg = userMessage.toLowerCase();
  const matches: SkillMatch[] = [];

  for (const skill of SKILLS) {
    const matchedPatterns: string[] = [];
    for (const pattern of skill.triggerPatterns) {
      try {
        const regex = new RegExp(pattern, 'i');
        if (regex.test(lowerMsg)) {
          matchedPatterns.push(pattern);
        }
      } catch {
        if (lowerMsg.includes(pattern.toLowerCase())) {
          matchedPatterns.push(pattern);
        }
      }
    }
    if (matchedPatterns.length > 0) {
      matches.push({ skill, matchedPatterns });
    }
  }

  return matches;
}

export function buildSkillPrompt(basePrompt: string, userMessage: string): string {
  const matches = matchSkills(userMessage);
  const alwaysOnSkill = SKILLS.find((skill) => skill.name === 'reliable-file-editing');
  const activeMatches = [...matches];
  if (alwaysOnSkill && !activeMatches.some((match) => match.skill.name === alwaysOnSkill.name)) {
    activeMatches.unshift({ skill: alwaysOnSkill, matchedPatterns: ['always-on'] });
  }
  if (activeMatches.length === 0) return basePrompt;

  let enhanced = basePrompt + '\n\n## Active Skills\n';
  for (const match of activeMatches) {
    enhanced += `\n### Skill: ${match.skill.name}\n`;
    enhanced += `${match.skill.instructions}\n\n`;
  }

  return enhanced;
}
