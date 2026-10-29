// What Windows doesn't have: file names it refuses, the executable bit, a '..' after a link that
// leads where the link does rather than back where the link sits.
export const windows = process.platform === 'win32'

// macOS refuses file names that aren't valid UTF-8. NTFS holds them as lone surrogates.
export const macOS = process.platform === 'darwin'

// For /proc.
export const linux = process.platform === 'linux'

// Root reads anything, so a directory can't be locked against it.
export const runningAsRoot = process.getuid?.() === 0
