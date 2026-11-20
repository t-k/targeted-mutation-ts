#ifndef TMT_KRML_RUNTIME_H
#define TMT_KRML_RUNTIME_H

#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

#define KRML_HOST_EPRINTF(...) fprintf(stderr, __VA_ARGS__)
#define KRML_HOST_EXIT(status) exit(status)
#define KRML_MAYBE_UNUSED_VAR(value) ((void)(value))

#endif
