#include "TmtScan.h"

#define TmtScan_scan_class TmtScan_scan_class_low
#include "TmtScan.c"
#undef TmtScan_scan_class

#include "TmtPulseScan.h"

_Static_assert(TmtGrammar_Space == 0 && TmtGrammar_Identifier == 1 && TmtGrammar_DecimalDigits == 2,
  "Pulse scanner class encoding changed");

uint32_t TmtScan_scan_class(const uint8_t *source, uint32_t size, uint32_t at, TmtGrammar_byte_class cls)
{
  // Custard's array parameter uses a mutable pointer. The Pulse contract preserves all bytes for any read permission.
  return TmtPulseScan_scan_class((uint8_t *)source, size, at, cls);
}
