# Google-Cloud-Profiler-Terraform-Setup

Terraform code to setup the BigQuery dataset, and table to store the cloud profiler data in denormalized form.
Also contains the code for the UDF (user-defined function) to aggregate the profiles into a JSON string compatible with the d3-flame-graph library. 

This is used to create the Flamegraph community visualization in LookerStudio in the repository https://github.com/jatinAgarwala/Google-Cloud-Profiler-Looker-Dashboard.
