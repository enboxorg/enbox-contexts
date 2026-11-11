---
"@enbox/contexts": patch
---

Support composed consumer modules attached at descendant `$ref` paths beneath a shared context root (`ModuleContextAttachmentPath`) and derive canonical module role-scope descriptors directly from `enbox.using(module).graph` without requiring a host `enbox.modules` facade.
