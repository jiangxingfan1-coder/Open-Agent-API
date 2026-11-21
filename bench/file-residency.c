/* Optional read-only mincore probe for the benchmark's private database (macOS/Linux). */
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc != 2) return 2;
  int fd = open(argv[1], O_RDONLY);
  struct stat st;
  long page = sysconf(_SC_PAGESIZE);
  if (fd < 0 || fstat(fd, &st) || !S_ISREG(st.st_mode) || st.st_size <= 0 || page <= 0) return 1;
  size_t length = (size_t)st.st_size, pages = 1 + (length - 1) / (size_t)page;
  void *addr = mmap(NULL, length, PROT_READ, MAP_SHARED, fd, 0);
  unsigned char *vec = calloc(pages, 1);
  if (addr == MAP_FAILED || !vec || mincore(addr, length, (void *)vec)) return 1;
  size_t resident = 0;
  for (size_t i = 0; i < pages; i++) resident += vec[i] & 1;
  printf("{\"page_bytes\":%ld,\"pages\":%zu,\"resident\":%zu}\n", page, pages, resident);
  free(vec);
  munmap(addr, length);
  close(fd);
  return 0;
}
