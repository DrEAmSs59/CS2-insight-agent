/// Internal macro for calling observer methods efficiently.
///
/// This macro checks if any observers are interested in a particular event type
/// before iterating through them, improving performance.
#[doc(hidden)]
#[macro_export]
macro_rules! try_observers {
    ($self:ident, $flag:ident, $method:ident ( $($arg:expr),* )) => {{
        use $crate::Interests;
        if !$self.global_mask.intersects(Interests::$flag) {
            Ok(())
        } else {
            ($self.observers.iter_mut().zip($self.observer_masks.iter()))
                .try_for_each(|(obs, &mask)| {
                    if mask.intersects(Interests::$flag) {
                        obs.$method($($arg),*)
                    } else {
                        Ok(())
                    }
                })
        }
    }};
}
/// Macro for getting property from [`crate::Entity`].
///
/// # Examples
/// ```no_compile
/// let x: i32 = property!(entity, "property_name");
/// let y = property!(entity, i32, "property_name");
/// ```
#[macro_export]
macro_rules! property {
    ($ent:expr, $ty:ty, $fmt:literal, $($arg:tt)*) => {
        {
            let x: $ty = $ent.get_property(&format!($fmt, $($arg)*))?.try_into()?;
            x
        }
    };
    ($ent:expr, $ty:ty, $fmt:literal) => {
        {
            let x: $ty = $ent.get_property(&format!($fmt))?.try_into()?;
            x
        }
    };
    ($ent:expr, $fmt:expr, $($arg:tt)*) => {
        $ent.get_property(&format!($fmt, $($arg)*))?.try_into()?
    };
    ($ent:expr, $fmt:expr) => {{
        $ent.get_property(&format!($fmt))?.try_into()?
    }};
}

/// Same as [`crate::property`] but returns `None` if property doesn't exist for
/// given [`crate::Entity`] or cannot be converted into given type.
///
/// # Examples
/// ```no_compile
/// let x: i32 = try_property!(entity, "property_name").unwrap_or_default();
/// let y = try_property!(entity, i32, "property_name").unwrap_or_default();
/// ```
#[macro_export]
macro_rules! try_property {
    ($ent:expr, $ty:ty, $fmt:expr, $($arg:tt)*) => {
        {
            let x: Option<$ty> = $ent
                .get_property(&format!($fmt, $($arg)*))
                .ok()
                .and_then(|x| {
                    x.try_into().ok()
                });
            x
        }
    };

    ($ent:expr, $ty:ty, $fmt:expr) => {
        {
            let x: Option<$ty> = $ent
                .get_property(&format!($fmt))
                .ok()
                .and_then(|x| {
                    x.try_into().ok()
                });
            x
        }
    };

    ($ent:expr, $fmt:expr, $($arg:tt)*) => {
        $ent
            .get_property(&format!($fmt, $($arg)*))
            .ok()
            .and_then(|x| {
                x.try_into().ok()
            })
    };

    ($ent:expr, $fmt:expr) => {{
        $ent
            .get_property(&format!($fmt))
            .ok()
            .and_then(|x| {
                x.try_into().ok()
            })
    }};
}
