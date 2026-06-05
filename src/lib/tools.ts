import type { ToolDefinition } from '@/types/ec9v3';

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'create_file',
      description: 'Create a brand-new file with the given content. Creates parent directories if needed. Refuses to overwrite existing files; use read_file plus edit_file or multi_edit for existing files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the working directory (e.g., "index.html", "src/app.ts")' },
          content: { type: 'string', description: 'The complete file content to write' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of an existing text file. Use numbered:true when planning line/range edits. Binary files such as .db/images/PDFs are rejected to protect context. When context overload protection is enabled, large files return a chunk manifest and non-destructive chunk copy paths; read only the needed chunk files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the working directory' },
          numbered: { type: 'boolean', description: 'Return each line prefixed with a 1-based line number for replace_range or insert_at_line edits' },
          start_line: { type: 'number', description: 'Optional 1-based first line to return' },
          end_line: { type: 'number', description: 'Optional 1-based final line to return' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'List files and directories at a given path. Results are bounded and can be paged with offset. Use this to explore the working directory structure before creating or editing files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path relative to the working directory. Use "." for root or omit.' },
          offset: { type: 'number', description: 'Optional zero-based entry offset for the next page' },
          max_results: { type: 'number', description: 'Optional maximum entries to return for this page' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Edit an existing file after reading it with read_file. Supports targeted replace, replace_entire_file for broadly malformed files, replace_range with line numbers, insert_at_line, insert_before, insert_after, or append. Exact replacement is tried first, then safe unique fuzzy matching for line endings, escaped newlines, and trimmed blocks. If matching fails twice, read_file with numbered:true and use replace_range or replace_entire_file instead of deleting/recreating files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the working directory' },
          old_text: { type: 'string', description: 'Text to replace. Prefer a small unique snippet copied from the current read_file output.' },
          new_text: { type: 'string', description: 'Replacement or insertion text' },
          replace_entire_file: { type: 'boolean', description: 'Set true to replace the full content of an existing file after reading it. Use only when the file is broadly malformed.' },
          replace_range: { type: 'boolean', description: 'Set true to replace an inclusive 1-based line range using start_line and end_line' },
          start_line: { type: 'number', description: '1-based first line for replace_range' },
          end_line: { type: 'number', description: '1-based final line for replace_range' },
          insert_at_line: { type: 'number', description: '1-based line before which to insert new_text; use file length + 1 to append as a new line' },
          insert_before: { type: 'string', description: 'Unique anchor text. Inserts new_text before this anchor.' },
          insert_after: { type: 'string', description: 'Unique anchor text. Inserts new_text after this anchor.' },
          append: { type: 'string', description: 'Text to append to the end of the file. Use instead of old_text/new_text for simple appends.' },
          replace_all: { type: 'boolean', description: 'Replace all occurrences instead of just the first (default: false)' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'multi_edit',
      description: 'Apply multiple targeted edits to one file after reading it with read_file. Edits are applied sequentially and atomically. Each edit replaces the first unique match by default; set replace_all true on an edit only when every occurrence should change.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'File path relative to the working directory' },
          edits: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                old_string: { type: 'string', description: 'The exact text to find' },
                new_string: { type: 'string', description: 'The replacement text' },
                replace_all: { type: 'boolean', description: 'Replace every exact occurrence for this edit (default: false)' },
              },
              required: ['old_string', 'new_string'],
            },
            description: 'Array of {old_string, new_string} edit operations',
          },
        },
        required: ['file_path', 'edits'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: 'Delete a file from the working directory. Rare/destructive; do not use for normal edits or rewrites.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the working directory' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description: 'Search file contents using regular expressions. Much faster than reading files one by one. Results are bounded; narrow the pattern, path, or glob when the result reports omitted matches. Powered by ripgrep.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex pattern to search for' },
          path: { type: 'string', description: 'Directory to search in (default: working dir)' },
          glob: { type: 'string', description: 'File filter, e.g. "*.ts" or "*.{tsx,ts}"' },
          case_insensitive: { type: 'boolean', description: 'Case-insensitive search (default: false)' },
          max_results: { type: 'number', description: 'Maximum number of results (default: 100)' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'glob',
      description: 'Find files by name pattern. Example: "**/*.tsx" finds all TypeScript React files. Returns a bounded sorted set of file paths; narrow the pattern or path when additional matches are omitted.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern (e.g. "**/*.ts", "src/**/*.tsx")' },
          path: { type: 'string', description: 'Directory to search in (default: working dir)' },
          max_results: { type: 'number', description: 'Optional maximum number of paths to return' },
          exclude: {
            type: 'array',
            items: { type: 'string' },
            description: 'Patterns to exclude (e.g. ["node_modules", ".git"])',
          },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'shell_command',
      description: 'Execute a shell/terminal command. Use for running builds, tests, installing packages, git operations, and other CLI tasks. Commands have a 30-second timeout.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to execute' },
          working_directory: { type: 'string', description: 'Directory to run the command in (relative to project root). Omit to use the default working directory.' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web for information. Returns search result titles, URLs, and snippets. Use for looking up APIs, documentation, or any information not in your training data.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          max_results: { type: 'number', description: 'Maximum number of results to return (default: 5)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_webpage',
      description: 'Read the content of a webpage URL. Returns the page text content. Use for fetching documentation, API docs, or any online reference material.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The URL to read' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'todo',
      description: 'Manage a task list for tracking progress on complex multi-step workflows. Use to plan and show progress to the user.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['read', 'write'], description: '"read" to see current todos, "write" to update the todo list' },
          todos: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Task ID' },
                content: { type: 'string', description: 'Task description' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'removed'], description: 'Task status' },
                priority: { type: 'string', enum: ['high', 'medium', 'low'], description: 'Task priority' },
              },
              required: ['id', 'content', 'status', 'priority'],
            },
            description: 'Array of todo items (required for "write" action)',
          },
        },
        required: ['action'],
      },
    },
  },
];

export const TOOL_MAX_ITERATIONS = 20;
export const AUTOPROMPT_TOOL_MAX_ITERATIONS = 30;
