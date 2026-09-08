import { toNamespacedPath } from "node:path";

interface Win32Api {
  getFileSecurityW: (...args: any[]) => number;
  setFileSecurityW: (...args: any[]) => number;
  replaceFileW: (...args: any[]) => number;
  getLastError: () => number;
}

const DACL_SECURITY_INFORMATION = 0x00000004;
const PROTECTED_DACL_SECURITY_INFORMATION = 0x80000000;
let cached: Win32Api | undefined;

async function api(): Promise<Win32Api> {
  if (cached) return cached;
  const koffi = (await import("koffi")).default;
  const advapi32 = koffi.load("advapi32.dll");
  const kernel32 = koffi.load("kernel32.dll");
  cached = {
    getFileSecurityW: advapi32.func("int __stdcall GetFileSecurityW(const char16_t *path, uint32_t requested, void *descriptor, uint32_t length, _Out_ uint32_t *needed)"),
    setFileSecurityW: advapi32.func("int __stdcall SetFileSecurityW(const char16_t *path, uint32_t information, const void *descriptor)"),
    replaceFileW: kernel32.func("int __stdcall ReplaceFileW(const char16_t *replaced, const char16_t *replacement, const char16_t *backup, uint32_t flags, void *exclude, void *reserved)"),
    getLastError: kernel32.func("uint32_t __stdcall GetLastError()"),
  };
  return cached;
}

function winError(syscall: string, code: number, path: string): NodeJS.ErrnoException {
  const errno = code === 2 || code === 3 ? "ENOENT" : code === 5 ? "EACCES" : "EIO";
  const error = new Error(`${syscall} ${errno} (Win32 ${code}): ${path}`) as NodeJS.ErrnoException;
  error.code = errno;
  error.errno = code;
  error.syscall = syscall;
  error.path = path;
  return error;
}

async function readDacl(path: string): Promise<Buffer> {
  const native = await api();
  const needed: [number] = [0];
  native.getFileSecurityW(toNamespacedPath(path), DACL_SECURITY_INFORMATION, null, 0, needed);
  if (needed[0] === 0) throw winError("GetFileSecurityW", native.getLastError(), path);
  const descriptor = Buffer.alloc(needed[0]);
  if (native.getFileSecurityW(toNamespacedPath(path), DACL_SECURITY_INFORMATION, descriptor, descriptor.length, needed) === 0) {
    throw winError("GetFileSecurityW", native.getLastError(), path);
  }
  return descriptor.subarray(0, needed[0]);
}

export async function copyFileDaclWin32(source: string, destination: string): Promise<void> {
  const descriptor = await readDacl(source);
  const native = await api();
  const flags = (DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION) >>> 0;
  if (native.setFileSecurityW(toNamespacedPath(destination), flags, descriptor) === 0) {
    throw winError("SetFileSecurityW", native.getLastError(), destination);
  }
}

export async function replaceFileWin32(replaced: string, replacement: string): Promise<void> {
  const native = await api();
  if (native.replaceFileW(toNamespacedPath(replaced), toNamespacedPath(replacement), null, 0, null, null) === 0) {
    throw winError("ReplaceFileW", native.getLastError(), replaced);
  }
}
