fn main() {
    println!("cargo:rerun-if-changed=cpp/kernels.cpp");
    println!("cargo:rerun-if-env-changed=CXX");
    #[cfg(feature = "cpp")]
    {
        let mut b = cc::Build::new();
        b.cpp(true).file("cpp/kernels.cpp").opt_level(3);
        let tool = b.get_compiler();
        if tool.is_like_clang_cl() {
            b.flag("/std:c++17").flag("/clang:-march=armv8.2-a+crypto");
        } else if tool.is_like_msvc() {
            b.flag("/std:c++17");
        } else {
            b.flag("-std=c++17").flag("-march=armv8.2-a+crypto");
        }
        b.compile("cappz_cpp_kernels");
    }
}
