; Allow the app through Windows Firewall for devices on the same local network only (remoteip=localsubnet).
; Covers Wi-Fi marked "Public" too, so teammates never get blocked, while the internet can never reach it.
!macro customInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Manage with Bunny"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="Manage with Bunny" dir=in action=allow program="$INSTDIR\Manage with Bunny.exe" enable=yes profile=any remoteip=localsubnet'
!macroend
!macro customUnInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Manage with Bunny"'
!macroend
