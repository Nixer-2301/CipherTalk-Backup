@echo off
call "E:\VS\2022\Community\VC\Auxiliary\Build\vcvarsall.bat" x64 >nul
cl /Zs /std:c++17 /EHsc /utf-8 /DWCDB_API_BUILDING_LIBRARY /D_WIN32_WINNT=0x0601 /DNOMINMAX /DWIN32_LEAN_AND_MEAN /I"C:\ctbuild\wcdb_api\include"  "C:\ctbuild\wcdb_api\src\wcdb_api.cpp"
