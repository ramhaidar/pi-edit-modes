import fs from "node:fs";
import path from "node:path";
import ignorePkg, { type Ignore } from "ignore";

const createIgnore = ((ignorePkg as unknown as { default?: () => Ignore }).default ??
  ignorePkg) as () => Ignore;

export interface GeminiDiscoveryIgnoreOptions {
  respectGitIgnore?: boolean;
  respectGeminiIgnore?: boolean;
  customIgnoreFilePaths?: readonly string[];
}

function normalizedRelativePath(
  projectRoot: string,
  filePath: string,
  isDirectory: boolean,
): string | null {
  const relativePath = path.relative(projectRoot, filePath);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    return null;
  }
  let normalized = relativePath.split(path.sep).join(path.posix.sep);
  if (isDirectory && normalized && !normalized.endsWith("/")) normalized += "/";
  return normalized;
}

function isGitRepository(directory: string): boolean {
  try {
    let current = path.resolve(directory);
    while (true) {
      if (fs.existsSync(path.join(current, ".git"))) return true;
      const parent = path.dirname(current);
      if (parent === current) return false;
      current = parent;
    }
  } catch {
    return false;
  }
}

function parseRootIgnoreFile(projectRoot: string, fileName: string): string[] {
  try {
    const filePath = path.join(projectRoot, fileName);
    return fs
      .readFileSync(filePath, "utf8")
      .split(/\r\n|\n|\r/)
      .map((pattern) => pattern.trim())
      .filter((pattern) => pattern !== "" && !pattern.startsWith("#"));
  } catch {
    return [];
  }
}

function processGitIgnorePatterns(rawPatterns: string[], relativeBaseDir: string): string[] {
  return rawPatterns
    .map((pattern) => pattern.trimStart())
    .filter((pattern) => pattern !== "" && !pattern.startsWith("#"))
    .map((rawPattern) => {
      let pattern = rawPattern;
      const isNegative = pattern.startsWith("!");
      if (isNegative) pattern = pattern.substring(1);
      const isAnchoredInFile = pattern.startsWith("/");
      if (isAnchoredInFile) pattern = pattern.substring(1);
      if (pattern === "") return "";

      let processed = pattern;
      if (relativeBaseDir && relativeBaseDir !== ".") {
        if (!isAnchoredInFile && !pattern.includes("/")) {
          processed = path.posix.join("**", pattern);
        }
        processed = path.posix.join(relativeBaseDir, processed);
        if (!processed.startsWith("/")) processed = `/${processed}`;
      }
      if (isAnchoredInFile && !processed.startsWith("/")) processed = `/${processed}`;
      return isNegative ? `!${processed}` : processed;
    })
    .filter(Boolean);
}

function loadGitIgnorePatterns(projectRoot: string, patternsFilePath: string): Ignore {
  let content: string;
  try {
    content = fs.readFileSync(patternsFilePath, "utf8");
  } catch {
    return createIgnore();
  }

  const isExcludeFile = patternsFilePath.endsWith(path.join(".git", "info", "exclude"));
  const relativeBaseDir = isExcludeFile
    ? "."
    : path
        .dirname(path.relative(projectRoot, patternsFilePath))
        .split(path.sep)
        .join(path.posix.sep);
  return createIgnore().add(processGitIgnorePatterns(content.split(/\r\n|\n|\r/), relativeBaseDir));
}

export class GeminiDiscoveryIgnoreFilter {
  private readonly projectRoot: string;
  private readonly gitEnabled: boolean;
  private readonly respectGitIgnore: boolean;
  private readonly respectGeminiIgnore: boolean;
  private readonly geminiPatterns: Ignore;
  private readonly customPatterns: Ignore;
  private readonly gitIgnoreCache = new Map<string, Ignore>();
  private gitExcludePatterns: Ignore | undefined;

  constructor(projectRoot: string, options: GeminiDiscoveryIgnoreOptions = {}) {
    this.projectRoot = path.resolve(projectRoot);
    this.respectGitIgnore = options.respectGitIgnore ?? true;
    this.respectGeminiIgnore = options.respectGeminiIgnore ?? true;
    this.gitEnabled = this.respectGitIgnore && isGitRepository(this.projectRoot);
    this.geminiPatterns = createIgnore().add(
      this.respectGeminiIgnore
        ? processGitIgnorePatterns(parseRootIgnoreFile(this.projectRoot, ".geminiignore"), ".")
        : [],
    );
    const customPatterns = [...(options.customIgnoreFilePaths ?? [])]
      .reverse()
      .flatMap((fileName) => parseRootIgnoreFile(this.projectRoot, fileName));
    this.customPatterns = createIgnore().add(processGitIgnorePatterns(customPatterns, "."));
  }

  shouldIgnore(filePath: string, isDirectory: boolean): boolean {
    const normalizedPath = normalizedRelativePath(this.projectRoot, filePath, isDirectory);
    if (normalizedPath === null || normalizedPath === "" || normalizedPath === "/") return false;

    try {
      const rules = createIgnore().add(".git");
      if (this.gitEnabled && this.gitExcludePatterns === undefined) {
        const excludeFile = path.join(this.projectRoot, ".git", "info", "exclude");
        this.gitExcludePatterns = fs.existsSync(excludeFile)
          ? loadGitIgnorePatterns(this.projectRoot, excludeFile)
          : createIgnore();
      }
      if (this.gitEnabled && this.gitExcludePatterns) rules.add(this.gitExcludePatterns);

      const pathParts = normalizedPath.split("/").filter(Boolean);
      let currentDir = this.projectRoot;
      const dirsToVisit = [this.projectRoot];
      for (let index = 0; index < pathParts.length - 1; index += 1) {
        currentDir = path.join(currentDir, pathParts[index]);
        dirsToVisit.push(currentDir);
      }

      for (const dir of dirsToVisit) {
        const relativeDir = path.relative(this.projectRoot, dir);
        if (relativeDir) {
          const parentNormalized = normalizedRelativePath(this.projectRoot, dir, true);
          if (parentNormalized && this.isIgnoredByConfiguredRules(parentNormalized, rules)) {
            break;
          }
        }

        if (this.gitEnabled) {
          let patterns = this.gitIgnoreCache.get(dir);
          if (patterns === undefined) {
            const gitignorePath = path.join(dir, ".gitignore");
            patterns = fs.existsSync(gitignorePath)
              ? loadGitIgnorePatterns(this.projectRoot, gitignorePath)
              : createIgnore();
            this.gitIgnoreCache.set(dir, patterns);
          }
          rules.add(patterns);
        }
      }

      return this.isIgnoredByConfiguredRules(normalizedPath, rules);
    } catch {
      return false;
    }
  }

  private isIgnoredByConfiguredRules(normalizedPath: string, gitRules: Ignore): boolean {
    if (this.respectGitIgnore && this.respectGeminiIgnore) {
      return createIgnore()
        .add(gitRules)
        .add(this.geminiPatterns)
        .add(this.customPatterns)
        .ignores(normalizedPath);
    }
    if (this.customPatterns.ignores(normalizedPath)) return true;
    if (this.respectGitIgnore && this.gitEnabled && gitRules.ignores(normalizedPath)) return true;
    if (this.respectGeminiIgnore && this.geminiPatterns.ignores(normalizedPath)) return true;
    return false;
  }
}
