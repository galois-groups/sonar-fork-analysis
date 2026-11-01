REPORT zgreeting.

PARAMETERS p_count TYPE i.

IF p_count > 0.
  IF p_count < 10.
    WRITE / 'Few'.
  ENDIF.
ENDIF.
