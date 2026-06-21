#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/types.h>
#include <sys/ioctl.h>
#include <sys/select.h>
#include <errno.h>

/*
 * pty-helper: allocate a PTY and proxy master FD I/O
 *
 * Node.js v26+ lacks os.ptsname(), grantpt(), and unlockpt().
 * This helper does the POSIX PTY allocation that Node can't:
 *
 *  1. Opens /dev/ptmx to get a master FD
 *  2. Calls grantpt() + unlockpt() + ptsname_r()
 *  3. Writes the slave path to a header file (arg 1)
 *  4. Proxies: stdin → master PTY, master PTY → stdout
 *
 * Usage: pty-helper <header_file_path>
 *
 * The header file contains a single line: the slave PTY path (e.g. /dev/pts/5)
 * Node.js reads this file synchronously to discover the slave path,
 * then opens the slave itself (which works because the helper holds the master FD open).
 */

int main(int argc, char *argv[]) {
    if (argc != 2) {
        fprintf(stderr, "Usage: pty-helper <header_file_path>\n");
        return 1;
    }

    const char *header_path = argv[1];

    int master = open("/dev/ptmx", O_RDWR | O_NOCTTY);
    if (master < 0) {
        perror("open /dev/ptmx");
        return 1;
    }

    if (grantpt(master) == -1) {
        perror("grantpt");
        close(master);
        return 1;
    }

    if (unlockpt(master) == -1) {
        perror("unlockpt");
        close(master);
        return 1;
    }

    char slave_path[256];
    if (ptsname_r(master, slave_path, sizeof(slave_path)) != 0) {
        perror("ptsname_r");
        close(master);
        return 1;
    }

    /* Write the slave path to the header file */
    int hfd = open(header_path, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (hfd < 0) {
        perror("open header file");
        close(master);
        return 1;
    }
    {
        int n = strlen(slave_path);
        if (write(hfd, slave_path, n) != n || write(hfd, "\n", 1) != 1) {
            perror("write header");
            close(hfd);
            close(master);
            return 1;
        }
    }
    close(hfd);

    /* Proxy loop: stdin → master, master → stdout */
    char buf[65536];
    fd_set rfds;
    int maxfd = (STDIN_FILENO > master ? STDIN_FILENO : master) + 1;

    for (;;) {
        FD_ZERO(&rfds);
        FD_SET(master, &rfds);
        FD_SET(STDIN_FILENO, &rfds);

        int n = select(maxfd, &rfds, NULL, NULL, NULL);
        if (n < 0) {
            if (errno == EINTR) continue;
            break;
        }

        /* Data from master PTY → stdout */
        if (FD_ISSET(master, &rfds)) {
            ssize_t r = read(master, buf, sizeof(buf));
            if (r <= 0) break;
            ssize_t w = write(STDOUT_FILENO, buf, r);
            if (w != r) break;
        }

        /* Data from stdin → master PTY */
        if (FD_ISSET(STDIN_FILENO, &rfds)) {
            ssize_t r = read(STDIN_FILENO, buf, sizeof(buf));
            if (r <= 0) break;
            ssize_t w = write(master, buf, r);
            if (w != r) break;
        }
    }

    close(master);
    return 0;
}
