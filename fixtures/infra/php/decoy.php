<?php
// Deliberate issue for Sonar to find in a language this action doesn't test. The direct analysis
// reports it. The fork path must not analyse the file at all.
function double_it($n)
{
    $tripled = $n * 3;
    return $n * 2;
}
