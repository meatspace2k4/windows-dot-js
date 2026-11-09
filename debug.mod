# The mods a debugging page loads into its machines (win95.js): one a line, NAME or NAME:VALUE as the address's
# mod=NAME[:VALUE] (mod-NAME.js, its setting VALUE). The address's own mods are added to these, one of the same name
# taking its place. Chosen by the address (mods=debug) or the server (tools/serve.py --mods debug)
turbo:8@SETUP,W98SETUP,SUWIN,RUNONCE
setupscreen
setupclock
