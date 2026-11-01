# TFLint for the AWS stack. The AWS ruleset plugin is not enabled: it is downloaded from GitHub at init and cannot be verified offline here.
# Core rules only (unused declarations, deprecated syntax, naming, required versions/providers, documented variables and outputs).
config {
  call_module_type = "none"
}

plugin "terraform" {
  enabled = true
  preset  = "recommended"
}
